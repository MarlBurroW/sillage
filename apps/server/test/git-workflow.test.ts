import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { conversations, openDatabase, projects, runMigrations, users } from '@sillage/db'
import type {
  GitBranchesDto,
  GitChangeDto,
  GitCommitResultDto,
  GitRepoStatusDto,
  GitStashListDto,
  GitStatusDto,
} from '@sillage/protocol'
import type { Config } from '../src/config.js'
import {
  GitActionError,
  abortOperation,
  checkout,
  commit,
  continueOperation,
  createBranch,
  deleteBranch,
  discard,
  fetch,
  initRepository,
  merge,
  networkEnv,
  pull,
  push,
  readBranches,
  readFileDiff,
  readRepoStatus,
  readStashes,
  resetTo,
  revertCommit,
  serialized,
  stage,
  stashApply,
  stashDrop,
  stashPush,
  unstage,
} from '../src/git-workflow.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerGitActionRoutes } from '../src/http/routes/git-actions.js'
import { EventLog } from '../src/events/event-log.js'
import { WorktreeStatusService } from '../src/worktrees/status-service.js'

/** The module copies `process.env` to each git command. Isolate host identity, `commit.gpgsign`, `pull.rebase`, helpers and session identity variables so they cannot determine test results. */
const isolation = mkdtempSync(join(tmpdir(), 'sillage-git-isolation-'))
writeFileSync(join(isolation, 'gitconfig'), '')
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = join(isolation, 'gitconfig')
for (const name of [
  'EMAIL',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
]) {
  delete process.env[name]
}
after(() => rmSync(isolation, { recursive: true, force: true }))

// Tools

/** Synchronous git for setup and verification; only tested functions use the module. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

const line = (cwd: string, ...args: string[]): string => git(cwd, ...args).trim()
const lines = (cwd: string, ...args: string[]): string[] => git(cwd, ...args).split('\n').filter(Boolean)

const head = (repo: string): string => line(repo, 'rev-parse', 'HEAD')
const currentBranch = (repo: string): string => line(repo, 'rev-parse', '--abbrev-ref', 'HEAD')
const stagedNames = (repo: string): string[] => lines(repo, 'diff', '--cached', '--name-only')
const stagedStatus = (repo: string): string[][] =>
  lines(repo, 'diff', '--cached', '--name-status').map((entry) => entry.split('\t'))
const trackedFiles = (repo: string): string[] => lines(repo, 'ls-files')
const branchExists = (repo: string, name: string): boolean =>
  execFileSync('git', ['branch', '--list', name], { cwd: repo, encoding: 'utf8' }).trim().length > 0

function tempDir(t: TestContext, prefix = 'sillage-git-workflow-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function write(repo: string, file: string, content: string): void {
  mkdirSync(dirname(join(repo, file)), { recursive: true })
  writeFileSync(join(repo, file), content)
}

const read = (repo: string, file: string): string => readFileSync(join(repo, file), 'utf8')

function identify(repo: string): void {
  git(repo, 'config', 'user.name', 'Testeur')
  git(repo, 'config', 'user.email', 'testeur@example.com')
}

/** Empty repository on `main` with configured identity and no commits. */
function initRepo(t: TestContext, name = 'repo'): string {
  const repo = join(tempDir(t), name)
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  identify(repo)
  return repo
}

/** Starting point for most scenarios: repository with an initial commit. */
function createRepo(t: TestContext): string {
  const repo = initRepo(t)
  write(repo, 'README.md', 'Bonjour\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'Premier commit', '-m', 'Le corps du premier commit.')
  return repo
}

function commitFile(repo: string, file: string, content: string, message = `Modifie ${file}`): string {
  write(repo, file, content)
  git(repo, 'add', '-A', '--', file)
  git(repo, 'commit', '-q', '-m', message)
  return head(repo)
}

/** Disk remote named `origin`. Networking adds no value: git uses the same push/pull code for local bare repositories as servers. */
function createRemote(t: TestContext, repo: string): string {
  const dir = tempDir(t)
  const bare = join(dir, 'remote.git')
  git(dir, 'init', '-q', '--bare', '-b', 'main', bare)
  git(repo, 'remote', 'add', 'origin', bare)
  return bare
}

function cloneRemote(t: TestContext, bare: string): string {
  const dir = tempDir(t)
  const clone = join(dir, 'clone')
  git(dir, 'clone', '-q', bare, clone)
  identify(clone)
  return clone
}

async function statusOf(repo: string): Promise<GitRepoStatusDto> {
  const status = await readRepoStatus(repo)
  assert.ok(status, `${repo} devrait être un dépôt git`)
  return status
}

const byPath = (changes: GitChangeDto[]): Record<string, GitChangeDto> =>
  Object.fromEntries(changes.map((change) => [change.path, change]))

const summary = (changes: GitChangeDto[]): [string, string][] =>
  changes.map((change) => [change.path, change.kind])

/** Expected failure with code: `assert.rejects` alone would not identify which code arrived. */
async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<GitActionError> {
  let caught: unknown
  try {
    await promise
  } catch (err) {
    caught = err
  }
  assert.ok(caught instanceof GitActionError, `GitActionError ${code} attendue, reçu ${String(caught)}`)
  assert.equal(caught.code, code, caught.detail)
  return caught
}

// State

test('état : null hors d’un dépôt', async (t) => {
  assert.equal(await readRepoStatus(tempDir(t)), null)
})

test('état : index et répertoire de travail distingués, renommage et compteurs de lignes', async (t) => {
  const repo = createRepo(t)
  write(repo, 'a.txt', 'a\n')
  write(repo, 'both.txt', 'un\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'Deux fichiers', '-m', 'Un corps sur deux lignes.\nSeconde ligne.')

  write(repo, 'new.txt', 'ligne 1\nligne 2\n')
  git(repo, 'add', 'new.txt')
  write(repo, 'README.md', 'Bonjour\nSalut\n')
  write(repo, 'notes.txt', 'brouillon\n')
  git(repo, 'mv', 'a.txt', 'b.txt')
  // Same file in both areas: one version staged, another in the working tree.
  write(repo, 'both.txt', 'deux\n')
  git(repo, 'add', 'both.txt')
  write(repo, 'both.txt', 'deux\ntrois\n')

  const status = await statusOf(repo)
  assert.equal(status.branch, 'main')
  assert.equal(status.unborn, false)
  assert.equal(status.detached, false)
  assert.equal(status.operation, null)
  assert.equal(status.stashCount, 0)
  assert.equal(status.upstream, null)
  assert.deepEqual([status.ahead, status.behind], [0, 0])
  assert.deepEqual(status.remotes, [])
  assert.deepEqual(status.head, {
    hash: head(repo),
    shortHash: line(repo, 'rev-parse', '--short', 'HEAD'),
    subject: 'Deux fichiers',
    body: 'Un corps sur deux lignes.\nSeconde ligne.',
  })

  const staged = byPath(status.staged)
  assert.deepEqual(Object.keys(staged).sort(), ['b.txt', 'both.txt', 'new.txt'])
  assert.deepEqual(staged['new.txt'], { path: 'new.txt', oldPath: null, kind: 'added', added: 2, removed: 0 })
  assert.deepEqual(staged['b.txt'], { path: 'b.txt', oldPath: 'a.txt', kind: 'renamed', added: 0, removed: 0 })
  assert.deepEqual(staged['both.txt'], { path: 'both.txt', oldPath: null, kind: 'modified', added: 1, removed: 1 })

  const unstaged = byPath(status.unstaged)
  assert.deepEqual(Object.keys(unstaged).sort(), ['README.md', 'both.txt', 'notes.txt'])
  assert.deepEqual(unstaged['README.md'], { path: 'README.md', oldPath: null, kind: 'modified', added: 1, removed: 0 })
  assert.deepEqual(unstaged['both.txt'], { path: 'both.txt', oldPath: null, kind: 'modified', added: 1, removed: 0 })
  assert.deepEqual(unstaged['notes.txt'], { path: 'notes.txt', oldPath: null, kind: 'untracked', added: null, removed: null })
  assert.deepEqual(status.conflicted, [])
})

test('état : un dépôt sans commit est « unborn », son index se lit quand même', async (t) => {
  const repo = initRepo(t)
  write(repo, 'premier.txt', 'x\n')
  git(repo, 'add', 'premier.txt')
  write(repo, 'brouillon.txt', 'y\n')

  const status = await statusOf(repo)
  assert.equal(status.unborn, true)
  assert.equal(status.head, null)
  assert.equal(status.branch, 'main')
  assert.equal(status.detached, false)
  assert.deepEqual(status.staged, [{ path: 'premier.txt', oldPath: null, kind: 'added', added: 1, removed: 0 }])
  assert.deepEqual(summary(status.unstaged), [['brouillon.txt', 'untracked']])
  assert.equal(status.stashCount, 0)
})

test('diff par fichier : index, répertoire de travail et fichier non suivi', async (t) => {
  const repo = createRepo(t)
  write(repo, 'new.txt', 'ligne 1\n')
  git(repo, 'add', 'new.txt')
  write(repo, 'README.md', 'Bonjour\nSalut\n')
  write(repo, 'notes.txt', 'brouillon\n')

  const staged = await readFileDiff(repo, 'new.txt', 'staged')
  assert.match(staged.patch, /^diff --git a\/new\.txt b\/new\.txt\n/)
  assert.match(staged.patch, /\n\+ligne 1\n/)
  assert.equal(staged.truncated, false)

  const unstaged = await readFileDiff(repo, 'README.md', 'unstaged')
  assert.match(unstaged.patch, /\n\+Salut\n/)
  // README.md is absent from the index: its staged area is empty without errors.
  assert.equal((await readFileDiff(repo, 'README.md', 'staged')).patch, '')

  // Git exits 1 for differences against /dev/null: expected results rather than failures.
  const untracked = await readFileDiff(repo, 'notes.txt', 'untracked')
  assert.match(untracked.patch, /\nnew file mode 100644\n/)
  assert.match(untracked.patch, /\n\+brouillon\n/)
  assert.equal(untracked.truncated, false)
})

// Index

test('index : stage et unstage, par chemin ou en entier, suppressions comprises', async (t) => {
  const repo = createRepo(t)
  commitFile(repo, 'a.txt', 'a\n')
  commitFile(repo, 'b.txt', 'b\n')
  commitFile(repo, 'c.txt', 'c\n')

  write(repo, 'a.txt', 'a2\n')
  write(repo, 'b.txt', 'b2\n')
  unlinkSync(join(repo, 'c.txt'))
  write(repo, 'd.txt', 'd\n')

  await stage(repo, ['a.txt'])
  assert.deepEqual(stagedNames(repo), ['a.txt'])

  await stage(repo)
  assert.deepEqual(stagedStatus(repo), [['M', 'a.txt'], ['M', 'b.txt'], ['D', 'c.txt'], ['A', 'd.txt']])

  await unstage(repo, ['b.txt'])
  assert.deepEqual(stagedNames(repo), ['a.txt', 'c.txt', 'd.txt'])
  // Working directories remain unchanged: unstaging does not discard edits.
  assert.equal(read(repo, 'b.txt'), 'b2\n')

  await unstage(repo)
  assert.deepEqual(stagedNames(repo), [])
  assert.equal(read(repo, 'a.txt'), 'a2\n')
  assert.equal(existsSync(join(repo, 'c.txt')), false)
  assert.equal(read(repo, 'd.txt'), 'd\n')
})

test('index : unstage fonctionne sur un dépôt sans commit', async (t) => {
  const repo = initRepo(t)
  write(repo, 'x.txt', 'x\n')
  write(repo, 'y.txt', 'y\n')

  await stage(repo)
  assert.deepEqual(trackedFiles(repo), ['x.txt', 'y.txt'])
  await unstage(repo, ['x.txt'])
  assert.deepEqual(trackedFiles(repo), ['y.txt'])
  await unstage(repo)
  assert.deepEqual(trackedFiles(repo), [])
  assert.equal(read(repo, 'x.txt'), 'x\n')
})

test('index : discard ramène à l’index, restaure un fichier supprimé, efface un non suivi', async (t) => {
  const repo = createRepo(t)
  commitFile(repo, 'f.txt', 'v1\n')
  commitFile(repo, 'g.txt', 'g\n')

  write(repo, 'f.txt', 'v2\n')
  git(repo, 'add', 'f.txt')
  write(repo, 'f.txt', 'v3\n')
  unlinkSync(join(repo, 'g.txt'))
  write(repo, 'u.txt', 'u\n')
  write(repo, 'dossier/v.txt', 'v\n')
  write(repo, 'reste.txt', 'reste\n')

  await discard(repo, ['f.txt', 'g.txt', 'u.txt', 'dossier/v.txt'])
  // Restore index versions rather than HEAD: staged work remains preserved.
  assert.equal(read(repo, 'f.txt'), 'v2\n')
  assert.deepEqual(stagedNames(repo), ['f.txt'])
  assert.equal(read(repo, 'g.txt'), 'g\n')
  assert.equal(existsSync(join(repo, 'u.txt')), false)
  assert.equal(existsSync(join(repo, 'dossier/v.txt')), false)
  // Unrequested untracked files remain untouched.
  assert.equal(read(repo, 'reste.txt'), 'reste\n')
})

// Commit

test('commit : message gardé tel quel, stageAll, amend', async (t) => {
  const repo = createRepo(t)
  write(repo, 'a.txt', 'a\n')
  git(repo, 'add', 'a.txt')

  const message =
    'Sujet du commit\n\nPremier paragraphe,\nsur deux lignes.\n\n# Un dièse en tête de ligne fait partie du message.\n\nDernier paragraphe.\n'
  const result = await commit(repo, message, { amend: false, stageAll: false })
  assert.equal(result.hash, head(repo))
  assert.equal(result.shortHash, line(repo, 'rev-parse', '--short', 'HEAD'))
  assert.ok(result.hash.startsWith(result.shortHash))
  assert.deepEqual([result.conflicts, result.summary], [false, null])
  assert.equal(git(repo, 'log', '-1', '--format=%B').trimEnd(), message.trimEnd())

  // stageAll includes modified and untracked files without explicit stage calls.
  write(repo, 'a.txt', 'a2\n')
  write(repo, 'nouveau.txt', 'n\n')
  const all = await commit(repo, 'Tout d’un geste', { amend: false, stageAll: true })
  assert.deepEqual(lines(repo, 'show', '--name-only', '--format=', all.hash).sort(), ['a.txt', 'nouveau.txt'])
  const afterAll = await statusOf(repo)
  assert.deepEqual([afterAll.staged, afterAll.unstaged], [[], []])

  // amend retains commit counts while replacing the latest commit.
  const count = Number(line(repo, 'rev-list', '--count', 'HEAD'))
  write(repo, 'oubli.txt', 'o\n')
  git(repo, 'add', 'oubli.txt')
  const amended = await commit(repo, 'Tout d’un geste, corrigé', { amend: true, stageAll: false })
  assert.equal(Number(line(repo, 'rev-list', '--count', 'HEAD')), count)
  assert.notEqual(amended.hash, all.hash)
  assert.equal(amended.hash, head(repo))
  assert.equal(line(repo, 'log', '-1', '--format=%s'), 'Tout d’un geste, corrigé')
  assert.deepEqual(lines(repo, 'show', '--name-only', '--format=', 'HEAD').sort(), ['a.txt', 'nouveau.txt', 'oubli.txt'])
})

test('commit : rien à commiter et identité absente ont chacun leur code', async (t) => {
  const repo = createRepo(t)
  await rejectsWithCode(commit(repo, 'Rien', { amend: false, stageAll: false }), 'git_nothing_to_commit')

  // Unstaged modifications alone are insufficient too.
  write(repo, 'README.md', 'Bonjour\nmodifié\n')
  await rejectsWithCode(commit(repo, 'Rien dans l’index', { amend: false, stageAll: false }), 'git_nothing_to_commit')

  // No identity. Global configuration is empty, but domain-bearing hostnames let git
  // invent identities. `useConfigOnly` prevents this,
  // matching hosts without domains.
  const anonymous = join(tempDir(t), 'anonyme')
  mkdirSync(anonymous)
  git(anonymous, 'init', '-q', '-b', 'main')
  git(anonymous, 'config', 'user.useConfigOnly', 'true')
  write(anonymous, 'a.txt', 'a\n')
  git(anonymous, 'add', 'a.txt')
  const error = await rejectsWithCode(
    commit(anonymous, 'Sans identité', { amend: false, stageAll: false }),
    'git_identity_missing',
  )
  assert.ok(error.detail.length > 0)
  assert.equal((await statusOf(anonymous)).unborn, true)
})

// Branches

test('branches : courante, worktrees, amont avec avance et retard, branches distantes', async (t) => {
  const repo = createRepo(t)
  createRemote(t, repo)
  git(repo, 'push', '-q', '-u', 'origin', 'main')
  git(repo, 'branch', 'feature')
  git(repo, 'push', '-q', '-u', 'origin', 'feature')
  git(repo, 'branch', 'ailleurs')
  const worktree = join(tempDir(t), 'ailleurs')
  git(repo, 'worktree', 'add', '-q', worktree, 'ailleurs')

  // `origin/HEAD` exists on request: aliases must be excluded from branch lists.
  git(repo, 'remote', 'set-head', 'origin', '-a')
  assert.equal(line(repo, 'rev-parse', '--verify', 'refs/remotes/origin/HEAD').length, 40)

  // main: two pushed commits, one removed locally then a new one added → 1 ahead, 1 behind.
  commitFile(repo, 'un.txt', '1\n')
  commitFile(repo, 'deux.txt', '2\n')
  git(repo, 'push', '-q')
  git(repo, 'reset', '-q', '--hard', 'HEAD~1')
  commitFile(repo, 'trois.txt', '3\n')

  // feature loses its remote branch and becomes gone.
  git(repo, 'push', '-q', 'origin', '--delete', 'feature')
  git(repo, 'fetch', '-q', '--prune')

  const { local, remote } = await readBranches(repo)
  const locals = Object.fromEntries(local.map((branch) => [branch.name, branch]))
  assert.deepEqual(Object.keys(locals).sort(), ['ailleurs', 'feature', 'main'])

  const main = locals['main']
  assert.ok(main)
  assert.equal(main.current, true)
  assert.equal(main.hash, line(repo, 'rev-parse', '--short', 'HEAD'))
  assert.equal(main.subject, 'Modifie trois.txt')
  assert.equal(main.ts, Number(line(repo, 'log', '-1', '--format=%ct')) * 1000)
  assert.equal(main.upstream, 'origin/main')
  assert.deepEqual([main.ahead, main.behind, main.gone], [1, 1, false])
  assert.equal(main.worktreePath, realpathSync(repo))

  const feature = locals['feature']
  assert.ok(feature)
  assert.deepEqual([feature.current, feature.upstream, feature.gone, feature.worktreePath], [false, 'origin/feature', true, null])

  const elsewhere = locals['ailleurs']
  assert.ok(elsewhere)
  assert.deepEqual([elsewhere.current, elsewhere.upstream], [false, null])
  assert.equal(elsewhere.worktreePath, realpathSync(worktree))

  assert.deepEqual(remote.map((branch) => [branch.name, branch.remote]), [['origin/main', 'origin']])
  assert.equal(remote[0]?.hash, line(repo, 'rev-parse', '--short', 'origin/main'))
  assert.equal(remote[0]?.subject, 'Modifie deux.txt')

  // Branches checked out in other worktrees cannot be checked out here.
  await rejectsWithCode(checkout(repo, 'ailleurs'), 'git_branch_in_worktree')
})

test('branches : création, extraction locale, distante et détachée, suppression', async (t) => {
  const repo = createRepo(t)
  const first = head(repo)
  const second = commitFile(repo, 'deux.txt', '2\n')
  createRemote(t, repo)
  git(repo, 'push', '-q', '-u', 'origin', 'main')

  await createBranch(repo, 'sans-extraction', undefined, false)
  assert.equal(currentBranch(repo), 'main')
  assert.equal(line(repo, 'rev-parse', 'sans-extraction'), second)

  await createBranch(repo, 'depuis-le-premier', first, false)
  assert.equal(line(repo, 'rev-parse', 'depuis-le-premier'), first)

  await createBranch(repo, 'extraite', undefined, true)
  assert.equal(currentBranch(repo), 'extraite')
  await rejectsWithCode(createBranch(repo, 'extraite', undefined, false), 'git_ref_exists')

  await checkout(repo, 'main')
  assert.equal(currentBranch(repo), 'main')

  // Remote-only branches create tracking local counterparts.
  git(repo, 'branch', 'distante')
  git(repo, 'push', '-q', 'origin', 'distante')
  git(repo, 'branch', '-D', 'distante')
  await checkout(repo, 'origin/distante')
  assert.equal(currentBranch(repo), 'distante')
  assert.equal(line(repo, 'rev-parse', '--abbrev-ref', 'distante@{upstream}'), 'origin/distante')

  // Commits detach HEAD, reflected in state.
  await checkout(repo, first)
  const detached = await statusOf(repo)
  assert.deepEqual([detached.detached, detached.branch, detached.head?.hash], [true, null, first])

  await rejectsWithCode(checkout(repo, 'inexistante'), 'git_unknown_ref')

  // Reject checkouts overwriting modified files, preserving work.
  await checkout(repo, 'main')
  write(repo, 'deux.txt', 'modifié\n')
  await rejectsWithCode(checkout(repo, 'depuis-le-premier'), 'git_dirty_worktree')
  assert.equal(read(repo, 'deux.txt'), 'modifié\n')
  git(repo, 'checkout', '-q', '--', 'deux.txt')

  // Deletion rejects unmerged branches unless forced.
  git(repo, 'switch', '-q', '-c', 'non-fusionnee')
  commitFile(repo, 'nf.txt', 'nf\n')
  git(repo, 'switch', '-q', 'main')
  await rejectsWithCode(deleteBranch(repo, 'non-fusionnee', false), 'git_branch_unmerged')
  assert.equal(branchExists(repo, 'non-fusionnee'), true)
  await deleteBranch(repo, 'non-fusionnee', true)
  assert.equal(branchExists(repo, 'non-fusionnee'), false)

  await rejectsWithCode(deleteBranch(repo, 'main', false), 'git_branch_in_worktree')
  assert.equal(branchExists(repo, 'main'), true)

  await deleteBranch(repo, 'sans-extraction', false)
  assert.equal(branchExists(repo, 'sans-extraction'), false)
})

// Merge

test('fusion : conflit, abandon, reprise après résolution, avance rapide', async (t) => {
  const repo = createRepo(t)
  commitFile(repo, 'conflit.txt', 'base\n')
  git(repo, 'switch', '-q', '-c', 'cote')
  const side = commitFile(repo, 'conflit.txt', 'côté\n')
  git(repo, 'switch', '-q', 'main')
  const before = commitFile(repo, 'conflit.txt', 'principal\n')

  const conflicting = await merge(repo, 'cote')
  assert.equal(conflicting.conflicts, true)
  let status = await statusOf(repo)
  assert.equal(status.operation, 'merge')
  assert.deepEqual(status.conflicted, [{ path: 'conflit.txt', oldPath: null, kind: 'conflicted', added: null, removed: null }])
  assert.deepEqual([status.staged, status.unstaged], [[], []])

  await abortOperation(repo)
  status = await statusOf(repo)
  assert.deepEqual([status.operation, status.conflicted], [null, []])
  assert.equal(read(repo, 'conflit.txt'), 'principal\n')
  assert.equal(head(repo), before)
  await rejectsWithCode(abortOperation(repo), 'git_no_operation')
  await rejectsWithCode(continueOperation(repo), 'git_no_operation')

  assert.equal((await merge(repo, 'cote')).conflicts, true)
  // Continuing before resolution cannot commit and leaves merges pending.
  const unresolved = await continueOperation(repo)
  assert.equal(unresolved.conflicts, true)
  assert.equal((await statusOf(repo)).operation, 'merge')

  write(repo, 'conflit.txt', 'résolu\n')
  await stage(repo, ['conflit.txt'])
  const done = await continueOperation(repo)
  assert.equal(done.conflicts, false)
  status = await statusOf(repo)
  assert.deepEqual([status.operation, status.conflicted, status.staged], [null, [], []])
  assert.deepEqual(line(repo, 'log', '-1', '--format=%P').split(' '), [before, side])
  assert.equal(read(repo, 'conflit.txt'), 'résolu\n')

  // Fast-forward produces no merge commits and git explains the operation.
  git(repo, 'switch', '-q', '-c', 'rapide')
  const tip = commitFile(repo, 'rapide.txt', 'r\n')
  git(repo, 'switch', '-q', 'main')
  const fastForward = await merge(repo, 'rapide')
  assert.equal(fastForward.conflicts, false)
  assert.ok(typeof fastForward.summary === 'string' && fastForward.summary.length > 0)
  assert.equal(head(repo), tip)

  assert.deepEqual(await merge(repo, 'rapide'), { summary: 'Already up to date.', conflicts: false })
  await rejectsWithCode(merge(repo, 'nulle-part'), 'git_unknown_ref')
})

// Remote

test('remote : push publie et relie, fetch, pull en avance rapide, rejet, divergence, force', async (t) => {
  const env = networkEnv(null)
  const repo = createRepo(t)
  const bare = createRemote(t, repo)
  const base = head(repo)

  // Without upstreams, publish branches under their names and establish tracking.
  const published = await push(repo, { force: false, remote: undefined }, env)
  assert.equal(published.conflicts, false)
  assert.match(published.summary ?? '', /origin\/main/)
  let status = await statusOf(repo)
  assert.deepEqual([status.upstream, status.ahead, status.behind], ['origin/main', 0, 0])
  assert.equal(line(bare, 'rev-parse', 'main'), base)

  // Explicit remote for another branch.
  git(repo, 'switch', '-q', '-c', 'seconde')
  await push(repo, { force: false, remote: 'origin' }, env)
  assert.equal((await statusOf(repo)).upstream, 'origin/seconde')
  git(repo, 'switch', '-q', 'main')

  // A second clone advances: fetch detects it and pull fast-forwards.
  const clone = cloneRemote(t, bare)
  const remoteCommit = commitFile(clone, 'clone.txt', '1\n')
  git(clone, 'push', '-q')
  git(clone, 'switch', '-q', '-c', 'ephemere')
  git(clone, 'push', '-q', '-u', 'origin', 'ephemere')

  const fetched = await fetch(repo, env)
  assert.equal(fetched.conflicts, false)
  status = await statusOf(repo)
  assert.deepEqual([status.ahead, status.behind], [0, 1])
  assert.ok((await readBranches(repo)).remote.some((branch) => branch.name === 'origin/ephemere'))

  const pulled = await pull(repo, undefined, env)
  assert.equal(pulled.conflicts, false)
  assert.equal(head(repo), remoteCommit)

  // Prune removes deleted remote branches on the next fetch.
  git(clone, 'push', '-q', 'origin', '--delete', 'ephemere')
  await fetch(repo, env)
  assert.equal((await readBranches(repo)).remote.some((branch) => branch.name === 'origin/ephemere'), false)

  // Both sides advance: reject push and strategyless pull; rebasing pull succeeds.
  git(clone, 'switch', '-q', 'main')
  const theirs = commitFile(clone, 'clone.txt', '2\n')
  git(clone, 'push', '-q')
  commitFile(repo, 'local.txt', 'l\n')
  await rejectsWithCode(push(repo, { force: false, remote: undefined }, env), 'git_push_rejected')
  await rejectsWithCode(pull(repo, undefined, env), 'git_pull_diverged')
  const rebased = await pull(repo, true, env)
  assert.equal(rebased.conflicts, false)
  assert.equal(line(repo, 'rev-parse', 'HEAD~1'), theirs)
  assert.equal(line(repo, 'log', '-1', '--format=%s'), 'Modifie local.txt')

  const pushed = await push(repo, { force: false, remote: undefined }, env)
  assert.equal(pushed.conflicts, false)
  assert.equal(line(bare, 'rev-parse', 'main'), head(repo))

  // Rewritten commits reject ordinary push but accept force-with-lease.
  git(repo, 'commit', '-q', '--amend', '-m', 'Local, réécrit')
  await rejectsWithCode(push(repo, { force: false, remote: undefined }, env), 'git_push_rejected')
  const forced = await push(repo, { force: true, remote: undefined }, env)
  assert.equal(forced.conflicts, false)
  assert.equal(line(bare, 'rev-parse', 'main'), head(repo))
  assert.equal(line(bare, 'log', '-1', '--format=%s'), 'Local, réécrit')
})

test('remote : sans remote, sans amont, HEAD détachée', async (t) => {
  const env = networkEnv(null)
  const repo = createRepo(t)
  await rejectsWithCode(push(repo, { force: false, remote: undefined }, env), 'git_remote_unreachable')

  createRemote(t, repo)
  git(repo, 'switch', '-q', '-c', 'seule')
  await rejectsWithCode(pull(repo, undefined, env), 'git_no_upstream')

  git(repo, 'switch', '-q', '--detach')
  await rejectsWithCode(push(repo, { force: false, remote: undefined }, env), 'git_detached_push')
})

// Stash

test('stash : empiler, lister, appliquer, dépiler, jeter, et le compteur suit', async (t) => {
  const repo = createRepo(t)
  const short = line(repo, 'rev-parse', '--short', 'HEAD')

  write(repo, 'README.md', 'Bonjour\nstash 1\n')
  write(repo, 'u1.txt', 'u1\n')
  const first = await stashPush(repo, 'premier', true)
  assert.equal(first.conflicts, false)
  assert.equal(read(repo, 'README.md'), 'Bonjour\n')
  assert.equal(existsSync(join(repo, 'u1.txt')), false)
  assert.equal((await statusOf(repo)).stashCount, 1)

  write(repo, 'README.md', 'Bonjour\nstash 2\n')
  await stashPush(repo, 'second', false)
  // Without messages, git generates branch/commit text from which branches are extracted.
  write(repo, 'README.md', 'Bonjour\nstash 3\n')
  await stashPush(repo, undefined, false)
  assert.equal((await statusOf(repo)).stashCount, 3)

  let stashes = await readStashes(repo)
  assert.deepEqual(stashes.map((stash) => [stash.index, stash.branch]), [[0, 'main'], [1, 'main'], [2, 'main']])
  assert.deepEqual(stashes.map((stash) => stash.message), [`${short} Premier commit`, 'second', 'premier'])
  assert.ok(stashes.every((stash) => stash.ts > 0))

  await stashDrop(repo, 0)
  stashes = await readStashes(repo)
  assert.deepEqual(stashes.map((stash) => [stash.index, stash.message]), [[0, 'second'], [1, 'premier']])

  // apply retains stashes and restores untracked files too.
  const applied = await stashApply(repo, 1, false)
  assert.equal(applied.conflicts, false)
  assert.equal(read(repo, 'README.md'), 'Bonjour\nstash 1\n')
  assert.equal(read(repo, 'u1.txt'), 'u1\n')
  assert.equal((await statusOf(repo)).stashCount, 2)

  git(repo, 'checkout', '-q', '--', 'README.md')
  unlinkSync(join(repo, 'u1.txt'))
  const popped = await stashApply(repo, 0, true)
  assert.equal(popped.conflicts, false)
  assert.equal(read(repo, 'README.md'), 'Bonjour\nstash 2\n')
  assert.deepEqual((await readStashes(repo)).map((stash) => stash.message), ['premier'])
  assert.equal((await statusOf(repo)).stashCount, 1)

  // Nothing to stash is not an error.
  git(repo, 'checkout', '-q', '--', 'README.md')
  assert.deepEqual(await stashPush(repo, 'vide', true), { summary: 'No local changes to save', conflicts: false })
  assert.equal((await statusOf(repo)).stashCount, 1)
})

// Commits

test('commits : revert ajoute l’inverse, reset soft, mixed et hard', async (t) => {
  const repo = createRepo(t)
  const base = commitFile(repo, 's.txt', 'v1\n')
  const added = commitFile(repo, 'r.txt', 'r\n', 'Ajoute r.txt')

  const reverted = await revertCommit(repo, added)
  assert.equal(reverted.conflicts, false)
  assert.equal(Number(line(repo, 'rev-list', '--count', 'HEAD')), 4)
  assert.equal(existsSync(join(repo, 'r.txt')), false)
  assert.match(line(repo, 'log', '-1', '--format=%s'), /^Revert "Ajoute r\.txt"/)

  // Conflicting reverts leave conflicts removed by aborting.
  const changed = commitFile(repo, 's.txt', 'v2\n')
  commitFile(repo, 's.txt', 'v3\n')
  const conflicting = await revertCommit(repo, changed)
  assert.equal(conflicting.conflicts, true)
  let status = await statusOf(repo)
  assert.equal(status.operation, 'revert')
  assert.deepEqual(summary(status.conflicted), [['s.txt', 'conflicted']])
  await abortOperation(repo)
  assert.equal((await statusOf(repo)).operation, null)
  assert.equal(read(repo, 's.txt'), 'v3\n')

  // Reset to `base` from HEAD where s.txt contains v3.
  const tip = head(repo)
  await resetTo(repo, base, 'soft')
  assert.equal(head(repo), base)
  status = await statusOf(repo)
  assert.deepEqual(summary(status.staged), [['s.txt', 'modified']])
  assert.deepEqual(status.unstaged, [])
  assert.equal(read(repo, 's.txt'), 'v3\n')

  git(repo, 'reset', '-q', '--hard', tip)
  await resetTo(repo, base, 'mixed')
  assert.equal(head(repo), base)
  status = await statusOf(repo)
  assert.deepEqual(status.staged, [])
  assert.deepEqual(summary(status.unstaged), [['s.txt', 'modified']])
  assert.equal(read(repo, 's.txt'), 'v3\n')

  git(repo, 'reset', '-q', '--hard', tip)
  await resetTo(repo, base, 'hard')
  assert.equal(head(repo), base)
  status = await statusOf(repo)
  assert.deepEqual([status.staged, status.unstaged], [[], []])
  assert.equal(read(repo, 's.txt'), 'v1\n')

  // Unknown hashes produce unclassified git errors whose details name the hash.
  await assert.rejects(
    resetTo(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'hard'),
    (err: unknown) => err instanceof GitActionError && /deadbeef/.test(err.detail),
  )
  assert.equal(head(repo), base)
})

// Repository

test('dépôt : init crée un dépôt sur main, et refuse un dossier déjà dans un dépôt', async (t) => {
  const dir = tempDir(t)
  assert.equal(await readRepoStatus(dir), null)
  await initRepository(dir)
  const status = await statusOf(dir)
  assert.deepEqual([status.branch, status.unborn, status.head], ['main', true, null])
  await rejectsWithCode(initRepository(dir), 'git_already_repository')

  // Subdirectories of repositories must not become unsolicited subrepositories.
  const nested = join(createRepo(t), 'sous-dossier')
  mkdirSync(nested)
  await rejectsWithCode(initRepository(nested), 'git_already_repository')
  assert.equal(existsSync(join(nested, '.git')), false)
})

// Serialization

test('sérialisation : une action à la fois par dépôt, l’échec de l’une ne bloque pas la suivante', async () => {
  const order: string[] = []
  const slow = serialized('/depot/a', async () => {
    order.push('a:début')
    await new Promise((resolve) => setTimeout(resolve, 30))
    order.push('a:fin')
    return 'a'
  })
  const queued = serialized('/depot/a', async () => {
    order.push('b:début')
    order.push('b:fin')
    return 'b'
  })
  // Other repositories do not await the first.
  const elsewhere = serialized('/depot/b', async () => {
    order.push('c:début')
    return 'c'
  })
  assert.deepEqual(await Promise.all([slow, queued, elsewhere]), ['a', 'b', 'c'])
  assert.deepEqual(order, ['a:début', 'c:début', 'a:fin', 'b:début', 'b:fin'])

  const failing = serialized('/depot/c', async () => {
    throw new Error('boum')
  })
  const next = serialized('/depot/c', async () => 'ok')
  await assert.rejects(failing, /boum/)
  assert.equal(await next, 'ok')
})

// Routes

async function harness(t: TestContext) {
  const repo = createRepo(t)
  const dir = tempDir(t, 'sillage-git-routes-')
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', isAdmin: false, createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: repo, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const plain = join(dir, 'plain')
  mkdirSync(plain)
  db.insert(projects).values({ id: 'plain', name: 'plain', workspacePath: plain, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  db.insert(conversations).values({
    id: 'conversation', projectId: 'project', userId: 'owner', title: 'Fil', agent: 'claude', config: '{}', status: 'idle',
    createdAt: 1, updatedAt: 1,
  }).run()

  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, 'owner')).get()
  })
  registerErrorHandler(app)
  // Routes invalidate worktree progress after each action: use a real service
  // on this database without reading it here.
  registerGitActionRoutes(
    app,
    { db, config: { paths: { data: dir, database: join(dir, 'test.sqlite') } } as Config },
    new WorktreeStatusService(db, new EventLog(db)),
  )
  t.after(() => app.close())

  return { repo, plain, app }
}

test('routes : état, stage sans corps, commit, branches, stash', async (t) => {
  const { repo, app } = await harness(t)

  const status = await app.inject({ url: '/api/projects/project/git/status' })
  assert.equal(status.statusCode, 200, status.body)
  const body = status.json<GitStatusDto>()
  assert.equal(body.cwd, repo)
  assert.deepEqual([body.repo?.branch, body.repo?.head?.hash], ['main', head(repo)])

  // Conversation scope reaches the same repository; unknown projects remain not found.
  const viaConversation = await app.inject({ url: '/api/conversations/conversation/git/status' })
  assert.equal(viaConversation.json<GitStatusDto>().cwd, repo)
  const unknown = await app.inject({ url: '/api/projects/nope/git/status' })
  assert.equal(unknown.statusCode, 404)
  assert.equal(unknown.json().error.code, 'project_not_found')

  write(repo, 'a.txt', 'a\n')
  write(repo, 'README.md', 'Bonjour\nmodifié\n')
  const diff = await app.inject({ url: '/api/projects/project/git/file-diff?path=a.txt&area=untracked' })
  assert.equal(diff.statusCode, 200, diff.body)
  assert.match(diff.json().patch, /new file mode/)

  const staged = await app.inject({ method: 'POST', url: '/api/projects/project/git/stage' })
  assert.equal(staged.statusCode, 204, staged.body)
  assert.deepEqual(stagedNames(repo), ['README.md', 'a.txt'])

  const committed = await app.inject({ method: 'POST', url: '/api/projects/project/git/commit', payload: { message: 'Depuis la route' } })
  assert.equal(committed.statusCode, 200, committed.body)
  const result = committed.json<GitCommitResultDto>()
  assert.equal(result.hash, head(repo))
  assert.ok(result.hash.startsWith(result.shortHash) && result.shortHash.length >= 7)
  assert.equal(line(repo, 'log', '-1', '--format=%s'), 'Depuis la route')

  git(repo, 'branch', 'a-supprimer')
  const deleted = await app.inject({ method: 'DELETE', url: '/api/projects/project/git/branches', payload: { name: 'a-supprimer' } })
  assert.equal(deleted.statusCode, 204, deleted.body)
  assert.equal(branchExists(repo, 'a-supprimer'), false)

  const created = await app.inject({ method: 'POST', url: '/api/projects/project/git/branches', payload: { name: 'nouvelle', checkout: false } })
  assert.equal(created.statusCode, 204, created.body)
  const branches = await app.inject({ url: '/api/projects/project/git/branches' })
  assert.deepEqual(branches.json<GitBranchesDto>().local.map((branch) => branch.name).sort(), ['main', 'nouvelle'])

  write(repo, 'README.md', 'Bonjour\nà mettre de côté\n')
  const stashed = await app.inject({ method: 'POST', url: '/api/projects/project/git/stash', payload: { message: 'de côté' } })
  assert.equal(stashed.statusCode, 200, stashed.body)
  assert.equal(stashed.json().conflicts, false)
  const stashes = await app.inject({ url: '/api/projects/project/git/stashes' })
  assert.deepEqual(stashes.json<GitStashListDto>().stashes.map((stash) => [stash.index, stash.message, stash.branch]), [[0, 'de côté', 'main']])
})

test('routes : un dossier sans dépôt a un état null, puis init en fait un', async (t) => {
  const { plain, app } = await harness(t)
  const before = await app.inject({ url: '/api/projects/plain/git/status' })
  assert.deepEqual(before.json<GitStatusDto>(), { cwd: plain, repo: null })

  const created = await app.inject({ method: 'POST', url: '/api/projects/plain/git/init' })
  assert.equal(created.statusCode, 204, created.body)
  const after = await app.inject({ url: '/api/projects/plain/git/status' })
  assert.deepEqual([after.json<GitStatusDto>().repo?.branch, after.json<GitStatusDto>().repo?.unborn], ['main', true])

  const again = await app.inject({ method: 'POST', url: '/api/projects/plain/git/init' })
  assert.equal(again.statusCode, 400, again.body)
  assert.equal(again.json().error.code, 'git_already_repository')
})

test('routes : validation en 400, états du dépôt en 409, chemin hors dépôt', async (t) => {
  const { repo, app } = await harness(t)

  // Option-like names never reach git.
  const option = await app.inject({ method: 'POST', url: '/api/projects/project/git/checkout', payload: { ref: '--help' } })
  assert.equal(option.statusCode, 400, option.body)
  assert.equal(option.json().error.code, 'validation_failed')
  assert.equal(currentBranch(repo), 'main')

  const blank = await app.inject({ method: 'POST', url: '/api/projects/project/git/commit', payload: { message: '   ' } })
  assert.equal(blank.statusCode, 400)
  assert.equal(blank.json().error.code, 'validation_failed')

  const none = await app.inject({ method: 'POST', url: '/api/projects/project/git/discard', payload: {} })
  assert.equal(none.statusCode, 400)
  assert.equal(none.json().error.code, 'validation_failed')

  // Remediable repository state returns 409 with git's explanation.
  git(repo, 'switch', '-q', '-c', 'non-fusionnee')
  commitFile(repo, 'nf.txt', 'nf\n')
  git(repo, 'switch', '-q', 'main')
  const unmerged = await app.inject({ method: 'DELETE', url: '/api/projects/project/git/branches', payload: { name: 'non-fusionnee' } })
  assert.equal(unmerged.statusCode, 409, unmerged.body)
  const error = unmerged.json().error
  assert.equal(error.code, 'git_branch_unmerged')
  assert.match(error.params.detail, /not fully merged/)
  assert.equal(branchExists(repo, 'non-fusionnee'), true)

  const forced = await app.inject({ method: 'DELETE', url: '/api/projects/project/git/branches', payload: { name: 'non-fusionnee', force: true } })
  assert.equal(forced.statusCode, 204, forced.body)

  // Nothing to commit describes requests rather than remediable state: 400.
  const nothing = await app.inject({ method: 'POST', url: '/api/projects/project/git/commit', payload: { message: 'Rien' } })
  assert.equal(nothing.statusCode, 400)
  assert.equal(nothing.json().error.code, 'git_nothing_to_commit')

  // Outside repositories, git rejects pathspecs with git error codes.
  const outside = await app.inject({ method: 'POST', url: '/api/projects/project/git/discard', payload: { paths: ['../ailleurs.txt'] } })
  assert.equal(outside.statusCode, 400, outside.body)
  assert.match(outside.json().error.code, /^git_/)
})

test('diff non suivi : ne pas masquer un fichier disparu par un patch vide', async (t) => {
  const repo = createRepo(t)
  await assert.rejects(readFileDiff(repo, 'absent.txt', 'untracked'), GitActionError)
})

test('diff : format stable malgré les préférences Git, depuis un sous-dossier', async (t) => {
  const repo = createRepo(t)
  write(repo, 'nested/échantillon.txt', 'Contenu réel\n')
  git(repo, 'config', 'color.ui', 'always')
  git(repo, 'config', 'diff.noprefix', 'true')
  git(repo, 'config', 'diff.mnemonicPrefix', 'true')
  const cwd = join(repo, 'nested')
  const status = await readRepoStatus(cwd)
  const change = status!.unstaged.find((entry) => entry.path.includes('échantillon'))!
  assert.ok(change)
  const diff = await readFileDiff(cwd, change.path, 'untracked')
  assert.match(diff.patch, /^diff --git /)
  assert.match(diff.patch, /\+Contenu réel/)
  assert.ok(!diff.patch.includes('\u001b['))
  await stage(cwd, [change.path])
  const staged = await readFileDiff(cwd, change.path, 'staged')
  assert.match(staged.patch, /\+Contenu réel/)
})

test('diff non suivi : distinguer le binaire et le fichier vide', async (t) => {
  const repo = createRepo(t)
  write(repo, 'image.bin', '\0image')
  write(repo, 'vide.txt', '')
  assert.match((await readFileDiff(repo, 'image.bin', 'untracked')).patch, /Binary files/)
  assert.match((await readFileDiff(repo, 'vide.txt', 'untracked')).patch, /new file mode/)
})

test('statut depuis un sous-dossier : chemins et compteurs cohérents avec les actions', async (t) => {
  const repo = createRepo(t)
  commitFile(repo, 'nested/source.txt', 'avant\n')
  write(repo, 'nested/source.txt', 'avant\naprès\n')
  write(repo, 'README.md', 'racine modifiée\n')
  const cwd = join(repo, 'nested')
  const status = await readRepoStatus(cwd)
  const change = status!.unstaged.find((entry) => entry.path === 'source.txt')!
  assert.ok(change)
  assert.equal(change.added, 1)
  assert.ok(status!.unstaged.some((entry) => entry.path === '../README.md'))
  assert.match((await readFileDiff(cwd, change.path, 'unstaged')).patch, /\+après/)
  await stage(cwd, [change.path])
  assert.equal((await readRepoStatus(cwd))!.staged[0]!.path, 'source.txt')
  await unstage(cwd, [change.path])
  await discard(cwd, [change.path])
  assert.equal(read(repo, 'nested/source.txt'), 'avant\n')
  git(repo, 'mv', 'nested/source.txt', 'nested/destination.txt')
  const renamed = (await readRepoStatus(cwd))!.staged[0]!
  assert.equal(renamed.path, 'destination.txt')
  assert.equal(renamed.oldPath, 'source.txt')
})
