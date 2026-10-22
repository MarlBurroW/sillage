import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import {
  MAX_UNTRACKED_BYTES,
  captureSnapshot,
  checkpointRef,
  copyCheckpoints,
  deleteCheckpoints,
  diffCheckpoint,
  readCheckpointFileDiff,
  readSnapshot,
  restoreSnapshot,
} from '../src/checkpoints.js'

/** Turn checkpoint capture, diff, restoration and cleanup. Isolate like `git-workflow.test.ts`: spawned git commands copy `process.env`, and host configuration must not determine results. */
const isolation = mkdtempSync(join(tmpdir(), 'sillage-checkpoint-isolation-'))
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
const line = (cwd: string, ...args: string[]): string => git(cwd, ...args).trim()
const lines = (cwd: string, ...args: string[]): string[] => git(cwd, ...args).split('\n').filter(Boolean)
const head = (repo: string): string => line(repo, 'rev-parse', 'HEAD')
const porcelain = (repo: string): string[] => lines(repo, 'status', '--porcelain', '--untracked-files=all')
const refs = (repo: string): string[] => lines(repo, 'for-each-ref', '--format=%(refname)', 'refs/sillage/')

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-checkpoints-'))
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

/** Repository with an initial commit: `a.txt`, `b.txt` and an ignored directory. */
function createRepo(t: TestContext): string {
  const repo = join(tempDir(t), 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  identify(repo)
  write(repo, 'a.txt', 'a\n')
  write(repo, 'b.txt', 'b\n')
  write(repo, '.gitignore', 'ignored/\n')
  write(repo, 'ignored/cache', 'x')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'Premier commit')
  return repo
}

const CONV = 'conversation-1'
const before = (conv = CONV, key = 'tour-1') => checkpointRef(conv, key, 'before')
const after_ = (conv = CONV, key = 'tour-1') => checkpointRef(conv, key, 'after')

const summary = (files: { path: string; kind: string }[]): [string, string][] =>
  files.map((file) => [file.path, file.kind]).sort()

test('la capture ignore les fichiers ignorés et les gros fichiers non suivis, sans toucher à l’index ni à HEAD', async (t) => {
  const repo = createRepo(t)
  write(repo, 'untracked.txt', 'u\n')
  write(repo, 'big.bin', 'x'.repeat(MAX_UNTRACKED_BYTES + 1))
  write(repo, 'a.txt', 'a2\n')
  const statusBefore = porcelain(repo)
  const headBefore = head(repo)

  const snapshot = await captureSnapshot(repo, before())
  assert.equal(snapshot.head, headBefore)
  assert.ok(snapshot.indexTree)

  // Nothing changed in the repository itself.
  assert.deepEqual(porcelain(repo), statusBefore)
  assert.equal(head(repo), headBefore)
  assert.deepEqual(lines(repo, 'diff', '--cached', '--name-only'), [])

  const captured = lines(repo, 'ls-tree', '-r', '--name-only', `${before()}:worktree`)
  assert.deepEqual(captured.sort(), ['.gitignore', 'a.txt', 'b.txt', 'untracked.txt'])
  assert.equal(line(repo, 'show', `${before()}:worktree/a.txt`), 'a2')

  // Refs point to trees: no commits appear in history.
  assert.equal(line(repo, 'cat-file', '-t', before()), 'tree')
  assert.deepEqual(lines(repo, 'log', '--all', '--format=%s'), ['Premier commit'])

  const reread = await readSnapshot(repo, before())
  assert.deepEqual(reread, snapshot)
  assert.equal(await readSnapshot(repo, checkpointRef(CONV, 'absent', 'before')), null)
})

test('le diff d’un tour liste les fichiers modifiés, créés, supprimés et non suivis', async (t) => {
  const repo = createRepo(t)
  write(repo, 'c.txt', 'c\n')
  await captureSnapshot(repo, before())

  write(repo, 'a.txt', 'a2\n')
  rmSync(join(repo, 'b.txt'))
  write(repo, 'c.txt', 'c2\n')
  write(repo, 'sub/d.txt', 'd\n')
  write(repo, 'ignored/other', 'y')
  await captureSnapshot(repo, after_())

  const diff = await diffCheckpoint(repo, CONV, 'tour-1', ['a.txt'])
  assert.deepEqual(summary(diff.files), [
    ['a.txt', 'modified'],
    ['b.txt', 'deleted'],
    ['c.txt', 'modified'],
    ['sub/d.txt', 'added'],
  ])
  assert.equal(diff.excluded, 0)
  const a = diff.files.find((file) => file.path === 'a.txt')
  assert.deepEqual([a?.added, a?.removed], [1, 1])

  const patch = await readCheckpointFileDiff(repo, CONV, 'tour-1', 'a.txt', null)
  assert.match(patch.patch, /^-a$/m)
  assert.match(patch.patch, /^\+a2$/m)
  assert.equal(patch.truncated, false)

  await assert.rejects(diffCheckpoint(repo, CONV, 'tour-2', []), { code: 'checkpoint_missing' })
})

test('un pull pendant le tour n’apparaît pas dans le diff, sauf ce que le tour a édité lui-même', async (t) => {
  const repo = createRepo(t)
  const dir = tempDir(t)
  const bare = join(dir, 'remote.git')
  git(dir, 'init', '-q', '--bare', '-b', 'main', bare)
  git(repo, 'remote', 'add', 'origin', bare)
  git(repo, 'push', '-q', '-u', 'origin', 'main')

  // A colleague pushes two files, only one of which the turn will also edit.
  const clone = join(dir, 'clone')
  git(dir, 'clone', '-q', bare, clone)
  identify(clone)
  write(clone, 'pulled.txt', 'from remote\n')
  write(clone, 'shared.txt', 'remote version\n')
  git(clone, 'add', '-A')
  git(clone, 'commit', '-q', '-m', 'Travail distant')
  git(clone, 'push', '-q')

  await captureSnapshot(repo, before())
  write(repo, 'a.txt', 'a2\n')
  git(repo, 'pull', '-q', '--no-rebase')
  write(repo, 'shared.txt', 'remote version\nplus mine\n')
  await captureSnapshot(repo, after_())

  const diff = await diffCheckpoint(repo, CONV, 'tour-1', ['a.txt', 'shared.txt'])
  assert.deepEqual(summary(diff.files), [
    ['a.txt', 'modified'],
    ['shared.txt', 'added'],
  ])
  assert.equal(diff.excluded, 1)
})

test('un commit de l’agent pendant le tour laisse ses fichiers listés', async (t) => {
  const repo = createRepo(t)
  await captureSnapshot(repo, before())
  write(repo, 'a.txt', 'committed by agent\n')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-q', '-m', 'Commit de l’agent')
  await captureSnapshot(repo, after_())

  const diff = await diffCheckpoint(repo, CONV, 'tour-1', ['a.txt'])
  assert.deepEqual(summary(diff.files), [['a.txt', 'modified']])
  assert.equal(diff.excluded, 0)
})

test('la restauration remet le répertoire de travail et l’index d’avant, sans toucher aux commits', async (t) => {
  const repo = createRepo(t)
  write(repo, 'untracked.txt', 'u\n')
  write(repo, 'big.bin', 'x'.repeat(MAX_UNTRACKED_BYTES + 1))
  write(repo, 'staged.txt', 'staged\n')
  git(repo, 'add', 'staged.txt')
  await captureSnapshot(repo, before())
  const headBefore = head(repo)
  const statusBefore = porcelain(repo)

  // Turn modifies, deletes, creates, stages, commits and writes ignored directories.
  write(repo, 'a.txt', 'a2\n')
  rmSync(join(repo, 'b.txt'))
  write(repo, 'untracked.txt', 'u2\n')
  write(repo, 'sub/deep/new.txt', 'new\n')
  git(repo, 'add', 'sub/deep/new.txt')
  git(repo, 'reset', '-q', 'staged.txt')
  write(repo, 'committed.txt', 'c\n')
  git(repo, 'add', '--intent-to-add', 'committed.txt')
  // Only this path: `new.txt` remains staged without being committed.
  git(repo, 'commit', '-q', '-m', 'Commit pendant le tour', '--', 'committed.txt')
  write(repo, 'ignored/generated', 'g')

  const result = await restoreSnapshot(repo, before())
  assert.equal(result.indexRestored, true)
  assert.ok(result.written >= 3)
  assert.ok(result.deleted >= 2)

  assert.equal(read(repo, 'a.txt'), 'a\n')
  assert.equal(read(repo, 'b.txt'), 'b\n')
  assert.equal(read(repo, 'untracked.txt'), 'u\n')
  assert.equal(existsSync(join(repo, 'sub')), false)
  assert.equal(existsSync(join(repo, 'committed.txt')), false)
  // Never captured, never deleted: ignored and oversized files remain.
  assert.equal(existsSync(join(repo, 'ignored/generated')), true)
  assert.equal(existsSync(join(repo, 'big.bin')), true)

  // The turn's commit remains; committed files exist there but no longer on disk.
  assert.notEqual(head(repo), headBefore)
  assert.equal(line(repo, 'log', '-1', '--format=%s'), 'Commit pendant le tour')
  assert.deepEqual(lines(repo, 'diff', '--cached', '--name-only').sort(), ['committed.txt', 'staged.txt'])
  assert.deepEqual(
    porcelain(repo).filter((entry) => !entry.endsWith('committed.txt') && !entry.endsWith('big.bin')).sort(),
    statusBefore.filter((entry) => !entry.endsWith('big.bin')).sort(),
  )
})

test('deux worktrees du même dépôt gardent chacun leurs captures', async (t) => {
  const repo = createRepo(t)
  const other = join(tempDir(t), 'wt')
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', other)

  await captureSnapshot(repo, before('conv-a'))
  await captureSnapshot(other, before('conv-b'))
  write(repo, 'a.txt', 'main side\n')
  write(other, 'a.txt', 'feature side\n')
  await captureSnapshot(repo, after_('conv-a'))
  await captureSnapshot(other, after_('conv-b'))

  assert.deepEqual(refs(repo).sort(), [
    'refs/sillage/checkpoints/conv-a/tour-1/after',
    'refs/sillage/checkpoints/conv-a/tour-1/before',
    'refs/sillage/checkpoints/conv-b/tour-1/after',
    'refs/sillage/checkpoints/conv-b/tour-1/before',
  ])
  const a = await readCheckpointFileDiff(repo, 'conv-a', 'tour-1', 'a.txt', null)
  const b = await readCheckpointFileDiff(other, 'conv-b', 'tour-1', 'a.txt', null)
  assert.match(a.patch, /\+main side/)
  assert.match(b.patch, /\+feature side/)

  await restoreSnapshot(other, before('conv-b'))
  assert.equal(read(other, 'a.txt'), 'a\n')
  assert.equal(read(repo, 'a.txt'), 'main side\n')

  assert.equal(await deleteCheckpoints(other, 'conv-b'), 2)
  assert.deepEqual(refs(repo).sort(), [
    'refs/sillage/checkpoints/conv-a/tour-1/after',
    'refs/sillage/checkpoints/conv-a/tour-1/before',
  ])
  assert.equal(await deleteCheckpoints(repo, 'conv-b'), 0)
})

test('une branche de conversation reçoit les captures de sa source, et les garde quand la source est nettoyée', async (t) => {
  const repo = createRepo(t)
  await captureSnapshot(repo, before('source'))
  write(repo, 'a.txt', 'a2\n')
  await captureSnapshot(repo, after_('source'))

  assert.equal(await copyCheckpoints(repo, 'source', 'branch'), 2)
  const diff = await diffCheckpoint(repo, 'branch', 'tour-1', [])
  assert.deepEqual(summary(diff.files), [['a.txt', 'modified']])

  await deleteCheckpoints(repo, 'source')
  assert.deepEqual(refs(repo).sort(), [
    'refs/sillage/checkpoints/branch/tour-1/after',
    'refs/sillage/checkpoints/branch/tour-1/before',
  ])
  assert.equal(await copyCheckpoints(repo, 'nobody', 'branch'), 0)
})

test('un projet sous la racine du dépôt ne voit que son sous-arbre, en chemins relatifs', async (t) => {
  const repo = createRepo(t)
  write(repo, 'app/index.ts', 'one\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'App')
  const project = join(repo, 'app')

  await captureSnapshot(project, before())
  write(repo, 'app/index.ts', 'two\n')
  write(repo, 'app/new.ts', 'n\n')
  write(repo, 'a.txt', 'outside\n')
  await captureSnapshot(project, after_())

  const diff = await diffCheckpoint(project, CONV, 'tour-1', ['index.ts'])
  assert.deepEqual(summary(diff.files), [
    ['index.ts', 'modified'],
    ['new.ts', 'added'],
  ])

  await restoreSnapshot(project, before())
  assert.equal(read(repo, 'app/index.ts'), 'one\n')
  assert.equal(existsSync(join(repo, 'app/new.ts')), false)
  assert.equal(read(repo, 'a.txt'), 'outside\n')
})

test('hors dépôt git, la capture refuse avec un code reconnaissable', async (t) => {
  const dir = tempDir(t)
  await assert.rejects(captureSnapshot(dir, before()), { code: 'checkpoint_not_repository' })
  assert.equal(await deleteCheckpoints(dir, CONV), 0)
})
