import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq as sqlEq, sql } from 'drizzle-orm'
import { cards, conversationPaths, conversations, openDatabase, projects, runMigrations, users, worktreeKeptFiles, worktrees } from '@sillage/db'
import type { TerminalManager } from '../src/terminals/terminal-manager.js'
import { EventLog } from '../src/events/event-log.js'
import { touchedPaths } from '../src/events/touched-paths.js'
import { assessWorktree, defaultBase, listWorktrees, parseWorktreeList, WorktreeListError } from '../src/worktrees/assess.js'
import { backfillCommandPaths } from '../src/worktrees/backfill.js'
import { WorktreeCleanup } from '../src/worktrees/cleanup.js'
import { WorktreeStatusService } from '../src/worktrees/status-service.js'
import type { WorktreePullRequest } from '@sillage/protocol'
import { githubRepoFromRemote as githubRepository } from '../src/git-credentials/github.js'
import { selectPullRequest, WorktreeRemoteStatus } from '../src/worktrees/remote-status.js'

/** Worktree progress: every card #46 state in a disposable repository. Isolate like `checkpoints.test.ts` so host git configuration cannot determine results. */
const isolation = mkdtempSync(join(tmpdir(), 'sillage-worktree-isolation-'))
writeFileSync(join(isolation, 'gitconfig'), '')
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = join(isolation, 'gitconfig')
for (const name of ['EMAIL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
  delete process.env[name]
}
after(() => rmSync(isolation, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function write(repo: string, file: string, content: string): void {
  mkdirSync(dirname(join(repo, file)), { recursive: true })
  writeFileSync(join(repo, file), content)
}

/** Repository on `main` with one commit and room for sibling worktrees. */
function repository(t: TestContext): { repo: string; trees: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-worktree-status-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Worktree test')
  git(repo, 'config', 'user.email', 'worktree@example.test')
  write(repo, 'README.md', 'base\n')
  write(repo, 'src/app.ts', 'export const app = 1\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'root')
  return { repo, trees: join(dir, 'trees') }
}

function addTree(repo: string, trees: string, branch: string): string {
  const path = join(trees, branch.replace(/\//g, '__'))
  git(repo, 'worktree', 'add', '-b', branch, path, 'main')
  return path
}

function commitAll(cwd: string, message: string): string {
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

async function assess(repo: string, path: string, options: { legacyGit?: boolean } = {}) {
  const entry = (await listWorktrees(repo)).find((e) => e.path === path)
  assert.ok(entry, `arbre ${path} inconnu de git`)
  return assessWorktree(repo, 'main', entry, options)
}

test('remote merges and exact PR heads deliver work without hiding later commits or leftovers', async (t) => {
  const { repo, trees } = repository(t)
  const dir = mkdtempSync(join(tmpdir(), 'sillage-worktree-pr-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: repo, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const project = db.select().from(projects).get()!
  const path = addTree(repo, trees, 'feat/pr')
  write(path, 'src/app.ts', 'export const app = 2\n')
  const head = commitAll(path, 'feature')
  const pulls = new Map<string, WorktreePullRequest>()
  const service = new WorktreeStatusService(db, new EventLog(db), { get: () => pulls, onRefreshed: () => {} })
  const current = async () => {
    service.invalidate(project.id)
    return (await service.current(project)).worktrees.find((tree) => tree.path === path)!
  }
  assert.equal((await current()).state, 'unmerged')
  // Remote main advances while local main remains behind.
  git(repo, 'update-ref', 'refs/remotes/origin/main', head)
  assert.equal((await current()).state, 'merged')
  git(repo, 'update-ref', '-d', 'refs/remotes/origin/main')
  // Squash followed by a conflicting edit: content comparison alone cannot prove delivery.
  git(repo, 'merge', '--squash', 'feat/pr')
  commitAll(repo, 'squash')
  write(repo, 'src/app.ts', 'export const app = 3\n')
  commitAll(repo, 'later edit')
  assert.equal((await current()).state, 'unmerged')
  pulls.set('feat/pr', { number: 42, url: 'https://github.com/example/repo/pull/42', state: 'merged', head, base: 'main', checks: null })
  assert.equal((await current()).state, 'merged')
  assert.equal((await current()).conflicts, false)
  write(path, 'leftover.txt', 'keep this\n')
  assert.equal((await current()).state, 'leftovers')
  assert.ok((await current()).fingerprint)
  rmSync(join(path, 'leftover.txt'))
  // A merge into another target, or a closed unmerged PR, proves nothing about main.
  pulls.set('feat/pr', { ...pulls.get('feat/pr')!, base: 'release' })
  assert.equal((await current()).state, 'unmerged')
  pulls.set('feat/pr', { ...pulls.get('feat/pr')!, base: 'main', state: 'closed' })
  assert.equal((await current()).state, 'unmerged')
  pulls.set('feat/pr', { ...pulls.get('feat/pr')!, state: 'merged' })
  write(path, 'new-work.txt', 'new work\n')
  commitAll(path, 'work after merge')
  assert.equal((await current()).state, 'unmerged')
})

test('PR matching excludes unrelated repositories and prefers a reopened branch', () => {
  assert.equal(githubRepository('git@github.com:Example/repo.git'), 'Example/repo')
  assert.equal(githubRepository('https://github.com/Example/repo.git'), 'Example/repo')
  assert.equal(githubRepository('ssh://git@github.com/Example/repo.git'), 'Example/repo')
  assert.equal(githubRepository('https://github.com.attacker.test/Example/repo'), null)
  const merged = { number: 1, html_url: 'https://github.com/upstream/repo/pull/1', state: 'closed' as const,
    draft: false, merged_at: '2026-01-01', head: { sha: 'abc', ref: 'feat/pr', repo: { full_name: 'fork/repo' } },
    base: { ref: 'main', repo: { full_name: 'upstream/repo' } } }
  const open = { ...merged, number: 2, state: 'open' as const, merged_at: null }
  assert.equal(selectPullRequest([merged, open], 'fork/repo', 'upstream/repo', 'feat/pr')?.number, 2)
  assert.equal(selectPullRequest([merged], 'other/repo', 'upstream/repo', 'feat/pr'), undefined)
  assert.equal(selectPullRequest([merged], 'fork/repo', 'other/repo', 'feat/pr'), undefined)
})

test('remote refresh runs in the background, preserves local branches and shares concurrent reads', async (t) => {
  const { repo, trees } = repository(t)
  const origin = join(trees, 'origin.git')
  mkdirSync(trees, { recursive: true })
  git(repo, 'clone', '--bare', repo, origin)
  git(repo, 'remote', 'add', 'origin', origin)
  const original = git(repo, 'rev-parse', 'main')
  git(repo, 'commit', '--allow-empty', '-m', 'Local commit')
  const localHead = git(repo, 'rev-parse', 'main')
  git(repo, 'branch', 'must-stay', localHead)
  // A repository can map fetched refs to local branches; the sidebar must ignore that mapping.
  git(repo, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/heads/must-stay')
  const dir = mkdtempSync(join(tmpdir(), 'sillage-remote-refresh-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'p', name: 'p', workspacePath: repo, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const project = db.select().from(projects).get()!
  const remote = new WorktreeRemoteStatus(db, { resolve: () => undefined }, { data: dir, database: join(dir, 'test.sqlite') })
  let count = 0
  let done: () => void = () => {}
  const refreshed = new Promise<void>((resolve) => { done = resolve })
  remote.onRefreshed = () => { count++; done() }
  const first = remote.get(project, ['feat/test'])
  assert.equal(first.size, 0)
  assert.equal(remote.get(project, ['feat/test']), first)
  await refreshed
  assert.equal(count, 1)
  assert.equal(git(repo, 'rev-parse', 'refs/remotes/origin/main'), original)
  assert.equal(git(repo, 'rev-parse', 'main'), localHead)
  assert.equal(git(repo, 'rev-parse', 'must-stay'), localHead)
  assert.equal(git(repo, 'status', '--porcelain'), '')
  remote.get(project, ['feat/test'])
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(count, 1)
})

test('les chemins Git Windows retrouvent le format des chemins enregistrés', () => {
  const raw = [
    'worktree C:/Users/André/projet', 'HEAD abc', 'branch refs/heads/main', '',
    'worktree C:/Users/André/Sillage/worktrees/review-060', 'HEAD def', 'branch refs/heads/review-060', '', '',
  ].join('\0')
  const entries = parseWorktreeList(raw, 'win32')
  assert.equal(entries[1]?.path, String.raw`C:\Users\André\Sillage\worktrees\review-060`)
  assert.equal(entries[1]?.branch, 'review-060')
  assert.equal(entries[1]?.prunable, false)
  assert.equal(entries[0]?.main, true)
  assert.equal(entries[1]?.main, false)
})

test('la liste Git conserve les chemins accentués et les caractères spéciaux', async (t) => {
  const { repo, trees } = repository(t)
  const path = join(trees, process.platform === 'win32' ? 'André travail' : 'André "travail"\nligne')
  git(repo, 'worktree', 'add', '-b', 'feat/accents', path, 'main')
  const entry = (await listWorktrees(repo)).find((tree) => tree.path === path)
  assert.ok(entry)
  assert.equal((await assessWorktree(repo, 'main', entry)).state, 'merged')
})

test('la base est la branche locale que désigne origin/HEAD, sinon main', async (t) => {
  const { repo } = repository(t)
  assert.equal(await defaultBase(repo), 'main')
  git(repo, 'branch', '-m', 'trunk')
  assert.equal(await defaultBase(repo), 'trunk')
  git(repo, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD')
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
  assert.equal(await defaultBase(repo), 'trunk')
  git(repo, 'branch', '-m', 'elsewhere')
  assert.equal(await defaultBase(repo), 'origin/trunk')
})

test('non commité, non suivi, commité non fusionné, en conflit', async (t) => {
  const { repo, trees } = repository(t)

  const dirty = addTree(repo, trees, 'feat/dirty')
  write(dirty, 'src/app.ts', 'export const app = 2\n')
  let result = await assess(repo, dirty)
  assert.equal(result.state, 'dirty')
  assert.deepEqual([result.modified, result.untracked, result.ahead], [1, 0, 0])
  assert.ok(result.lastEditAt !== null)

  const untracked = addTree(repo, trees, 'feat/untracked')
  write(untracked, 'notes.md', 'todo\n')
  result = await assess(repo, untracked)
  assert.equal(result.state, 'dirty')
  assert.deepEqual([result.modified, result.untracked], [0, 1])

  const unmerged = addTree(repo, trees, 'feat/unmerged')
  write(unmerged, 'src/feature.ts', 'export const feature = true\n')
  commitAll(unmerged, 'feature')
  result = await assess(repo, unmerged)
  assert.equal(result.state, 'unmerged')
  assert.deepEqual([result.ahead, result.behind, result.conflicts], [1, 0, false])
  assert.ok(result.lastCommitAt !== null)

  // Base advances on the same line, creating merge conflicts.
  write(repo, 'src/app.ts', 'export const app = 3\n')
  commitAll(repo, 'main moves')
  const conflicting = addTree(repo, trees, 'feat/conflict')
  git(conflicting, 'reset', '--hard', 'main~1')
  write(conflicting, 'src/app.ts', 'export const app = 4\n')
  commitAll(conflicting, 'conflicting')
  result = await assess(repo, conflicting)
  assert.equal(result.state, 'unmerged')
  assert.deepEqual([result.ahead, result.behind, result.conflicts], [1, 1, true])

  // Same without commits: local edits on a line changed in the base.
  const stale = addTree(repo, trees, 'feat/stale')
  git(stale, 'reset', '--hard', 'main~1')
  write(stale, 'src/app.ts', 'export const app = 5\n')
  result = await assess(repo, stale)
  assert.deepEqual([result.state, result.conflicts, result.behind], ['dirty', true, 1])
})

test('fusionné par merge, par squash et par cherry-pick', async (t) => {
  const { repo, trees } = repository(t)

  const merged = addTree(repo, trees, 'feat/merged')
  write(merged, 'src/a.ts', 'a\n')
  commitAll(merged, 'a')
  git(repo, 'merge', '--no-ff', 'feat/merged', '-m', 'merge a')
  let result = await assess(repo, merged)
  assert.equal(result.state, 'merged')
  assert.equal(result.ahead, 0)

  const squashed = addTree(repo, trees, 'feat/squashed')
  write(squashed, 'src/b.ts', 'b\n')
  commitAll(squashed, 'b1')
  write(squashed, 'src/b.ts', 'b2\n')
  commitAll(squashed, 'b2')
  git(repo, 'merge', '--squash', 'feat/squashed')
  git(repo, 'commit', '-m', 'squash b')
  result = await assess(repo, squashed)
  assert.equal(result.state, 'merged')
  // Ancestry would report two commits to merge: this is the trap avoided.
  assert.equal(result.ahead, 2)

  const picked = addTree(repo, trees, 'feat/picked')
  write(picked, 'src/c.ts', 'c\n')
  const hash = commitAll(picked, 'c')
  // Advance the base first; otherwise cherry-pick recreates the identical commit.
  write(repo, 'README.md', 'base 2\n')
  commitAll(repo, 'main moves')
  git(repo, 'cherry-pick', hash)
  result = await assess(repo, picked)
  assert.equal(result.state, 'merged')
  assert.equal(result.ahead, 1)

  // Merged work with new changes becomes active work again.
  write(picked, 'src/c.ts', 'c2\n')
  result = await assess(repo, picked)
  assert.equal(result.state, 'dirty')
})

test('du non commité et du non suivi que la base a déjà ne comptent pas', async (t) => {
  const { repo, trees } = repository(t)

  const tree = addTree(repo, trees, 'feat/copied')
  write(tree, 'src/app.ts', 'export const app = 2\n')
  write(tree, 'src/new.ts', 'new\n')
  // The same content reaches the base through another path (manual copy).
  write(repo, 'src/app.ts', 'export const app = 2\n')
  write(repo, 'src/new.ts', 'new\n')
  commitAll(repo, 'same content on main')

  const result = await assess(repo, tree)
  assert.equal(result.state, 'merged')
  assert.deepEqual([result.modified, result.untracked, result.behind], [1, 1, 1])

  // Additional untracked files absent from the base must be kept again.
  write(tree, 'src/other.ts', 'other\n')
  assert.equal((await assess(repo, tree)).state, 'dirty')
})

test('git antérieur à 2.40 : le non commité se juge par le stash entier, sans jamais conclure à tort', async (t) => {
  const { repo, trees } = repository(t)
  const legacy = { legacyGit: true }

  // No commits, but uncommitted content is already in the base: merged.
  const copied = addTree(repo, trees, 'feat/copied')
  write(copied, 'src/app.ts', 'export const app = 2\n')
  write(repo, 'src/app.ts', 'export const app = 2\n')
  commitAll(repo, 'same content on main')
  assert.equal((await assess(repo, copied, legacy)).state, 'merged')

  // Work absent from the base must be kept.
  write(copied, 'src/app.ts', 'export const app = 3\n')
  assert.equal((await assess(repo, copied, legacy)).state, 'dirty')

  // Squash-merged commits followed by uncommitted content also in the base: merged.
  const squashed = addTree(repo, trees, 'feat/squashed')
  write(squashed, 'src/s.ts', 's\n')
  commitAll(squashed, 's')
  write(squashed, 'README.md', 'base 2\n')
  git(repo, 'merge', '--squash', 'feat/squashed')
  write(repo, 'README.md', 'base 2\n')
  commitAll(repo, 'squash s with the readme')
  assert.equal((await assess(repo, squashed, legacy)).state, 'merged')
  assert.equal((await assess(repo, squashed)).state, 'merged', 'le chemin moderne dit pareil')

  // Unmerged commits prevent independent assessment of uncommitted work, so retain it
  // even if already in the base. This path errs on the cautious side.
  const pending = addTree(repo, trees, 'feat/pending')
  // Started before the commit adding 'base 2' to the base.
  git(pending, 'reset', '-q', '--hard', 'main~1')
  write(pending, 'src/p.ts', 'p\n')
  commitAll(pending, 'p')
  write(pending, 'README.md', 'base 2\n')
  assert.equal((await assess(repo, pending, legacy)).state, 'dirty')
  assert.equal((await assess(repo, pending)).state, 'unmerged', 'le chemin moderne sait que la modification est déjà dans la base')
})

test('introuvable : dossier disparu, entrée prunable', async (t) => {
  const { repo, trees } = repository(t)
  const gone = addTree(repo, trees, 'feat/gone')
  rmSync(gone, { recursive: true, force: true })
  const entry = (await listWorktrees(repo)).find((e) => e.path === gone)
  assert.ok(entry?.prunable)
  assert.equal((await assessWorktree(repo, 'main', entry)).state, 'missing')
  assert.equal((await assessWorktree(repo, 'main', { path: join(trees, 'nowhere'), head: null, prunable: false })).state, 'missing')
})

test('a git failure is not an empty list, and cleanup then deletes nothing', async (t) => {
  const { repo, trees } = repository(t)
  const dir = mkdtempSync(join(tmpdir(), 'sillage-worktree-failure-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: repo, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const project = db.select().from(projects).get()!
  const work = addTree(repo, trees, 'feat/work')
  db.insert(worktrees).values({ id: 'wt-work', projectId: 'project', name: 'feat/work', path: work, baseRef: 'main', createdBy: 'owner', createdAt: 1 }).run()
  write(work, 'src/wip.ts', 'export const wip = 1\n')

  const status = new WorktreeStatusService(db, new EventLog(db))
  const terminals = { underCwd: () => [] as string[], close: () => {} } as unknown as TerminalManager
  const cleanup = new WorktreeCleanup(db, dir, status, terminals, async () => {})
  assert.equal((await status.current(project)).worktrees.find((tree) => tree.path === work)?.state, 'dirty')

  // Only `git worktree list` fails, as when it times out under memory pressure: every other
  // git call still works, so the base is found and the trees get assessed.
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const shim = join(dir, 'bin')
  mkdirSync(shim)
  writeFileSync(join(shim, 'git'), `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = list ]; then exit 128; fi\nexec ${real} "$@"\n`, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${shim}:${path}`
  try {
    await assert.rejects(listWorktrees(repo), WorktreeListError)
    // It used to read as "no tree left": every tree became `missing`, and cleanup removed it.
    status.invalidate(project.id)
    await assert.rejects(cleanup.runMany(project, { paths: [work], deleteBranch: true, archiveSessions: false, stopServices: false }))
  } finally {
    process.env.PATH = path
  }
  assert.ok(existsSync(join(work, 'src/wip.ts')), 'uncommitted work survives')
  assert.equal(db.select().from(worktrees).where(sqlEq(worktrees.id, 'wt-work')).get()?.removedAt, null)
  // Outside a repository the list is still legitimately empty.
  assert.deepEqual(await listWorktrees(dir), [])
})

test('a directory git no longer lists reads as uncommitted work, not as missing', async (t) => {
  const { repo, trees } = repository(t)
  const dir = mkdtempSync(join(tmpdir(), 'sillage-worktree-unlisted-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: repo, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const project = db.select().from(projects).get()!
  // A tree whose administrative files git lost, still holding files.
  const orphan = addTree(repo, trees, 'feat/orphan')
  write(orphan, 'notes.md', 'precious\n')
  rmSync(join(repo, '.git', 'worktrees', 'feat__orphan'), { recursive: true, force: true })
  db.insert(worktrees).values({ id: 'wt-orphan', projectId: 'project', name: 'feat/orphan', path: orphan, baseRef: 'main', createdBy: 'owner', createdAt: 1 }).run()

  const status = new WorktreeStatusService(db, new EventLog(db))
  const tree = (await status.current(project)).worktrees.find((entry) => entry.path === orphan)!
  assert.equal(tree.state, 'dirty')
  assert.ok(tree.files.some((file) => file.path === 'notes.md'))

  const terminals = { underCwd: () => [] as string[], close: () => {} } as unknown as TerminalManager
  const cleanup = new WorktreeCleanup(db, dir, status, terminals, async () => {})
  const bulk = await cleanup.runMany(project, { paths: [orphan], deleteBranch: true, archiveSessions: false, stopServices: false })
  assert.deepEqual(bulk.items.map((item) => [item.outcome, item.outcome === 'skipped' ? item.reason : null]), [['skipped', 'changed']])
  assert.ok(existsSync(join(orphan, 'notes.md')))

  // Removing it on purpose still works: git says it is not a working tree, so the directory goes.
  const removed = (await cleanup.run(project, { path: orphan, deleteBranch: false, archiveSessions: false, stopServices: false }))!
  assert.equal(removed.removed, true)
  assert.ok(!existsSync(orphan))
})

test('la liste de git : arbre principal en tête, branche et HEAD détachée', async (t) => {
  const { repo, trees } = repository(t)
  addTree(repo, trees, 'feat/one')
  const detached = join(trees, 'detached')
  git(repo, 'worktree', 'add', '--detach', detached, 'main')
  const list = await listWorktrees(repo)
  assert.equal(list[0]?.path, repo)
  assert.equal(list[0]?.main, true)
  assert.equal(list[0]?.branch, 'main')
  assert.equal(list.find((e) => e.path === detached)?.branch, null)
  assert.equal(list.find((e) => e.path.endsWith('feat__one'))?.branch, 'feat/one')
  assert.deepEqual(await listWorktrees(trees), [])
})

test('les chemins révélés par un événement : éditions hors cwd, dossiers cités par Bash', () => {
  assert.deepEqual(touchedPaths({ type: 'file.edited', toolCallId: 't', path: 'src/a.ts', action: 'modified' }), [])
  assert.deepEqual(
    touchedPaths({ type: 'file.edited', toolCallId: 't', path: '/home/u/projects/x-feature/src/a.ts', action: 'modified' }),
    ['/home/u/projects/x-feature/src/a.ts'],
  )
  const bash = (command: string) =>
    touchedPaths({ type: 'tool.started', toolCallId: 't', name: 'Bash', input: { command }, parentToolCallId: null })
  assert.deepEqual(bash('cd /home/u/projects/x-feature && pnpm test'), ['/home/u/projects/x-feature'])
  assert.deepEqual(bash('git -C /home/u/projects/x-feature/ status'), ['/home/u/projects/x-feature'])
  assert.deepEqual(bash('git worktree add -b feat/x /home/u/projects/x-feature main'), ['/home/u/projects/x-feature'])
  assert.deepEqual(bash("cd '/home/u/my dir'; ls"), ['/home/u/my dir'])
  assert.deepEqual(bash('cd apps/web && ls /usr/bin'), [])
  assert.deepEqual(touchedPaths({ type: 'tool.started', toolCallId: 't', name: 'Read', input: { file_path: '/etc/hosts' }, parentToolCallId: null }), [])
})

test('le service réconcilie git et la base, et rattache les sessions', async (t) => {
  const { repo, trees } = repository(t)
  const dir = mkdtempSync(join(tmpdir(), 'sillage-worktree-db-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())

  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  const project = { id: 'project', name: 'project', workspacePath: repo, ownerId: 'owner', visibility: 'private' as const, createdAt: 1 }
  db.insert(projects).values(project).run()
  const projectRow = db.select().from(projects).where(sqlEq(projects.id, 'project')).get()!

  // Sillage-known tree with a session attached through cwd.
  const known = addTree(repo, trees, 'feat/known')
  db.insert(worktrees).values({ id: 'wt-known', projectId: 'project', name: 'feat/known', path: known, baseRef: 'HEAD', createdBy: 'owner', createdAt: 1 }).run()
  // External shell-created tree edited by a session whose cwd is the project root.
  const external = addTree(repo, trees, 'feat/external')
  // Ghost: database entry without directory or git entry, as left by `git worktree remove`
  // run outside Sillage. Its kept-files choice must go with it.
  db.insert(worktrees).values({ id: 'wt-ghost', projectId: 'project', name: 'feat/ghost', path: join(trees, 'ghost'), baseRef: 'HEAD', createdBy: 'owner', createdAt: 1 }).run()
  db.insert(worktreeKeptFiles).values({ projectId: 'project', path: join(trees, 'ghost'), fingerprint: 'old', files: 1, keptAt: 1 } as never).run()
  // Prunable: git still lists the tree but its directory vanished without `git worktree remove`.
  const vanished = addTree(repo, trees, 'feat/vanished')
  db.insert(worktrees).values({ id: 'wt-vanished', projectId: 'project', name: 'feat/vanished', path: vanished, baseRef: 'HEAD', createdBy: 'owner', createdAt: 1 }).run()
  rmSync(vanished, { recursive: true, force: true })

  const conversation = (id: string, worktreeId: string | null) => ({
    id, projectId: 'project', userId: 'owner', title: id, agent: 'claude' as const, config: '{}', status: 'idle' as const,
    worktreeId, createdAt: 1, updatedAt: 1,
  })
  db.insert(conversations).values([conversation('c-direct', 'wt-known'), conversation('c-root', null), conversation('c-both', 'wt-known')]).run()

  const log = new EventLog(db)
  const service = new WorktreeStatusService(db, log)
  // Journal entries attach sessions through edits, including commands.
  log.append('c-root', { type: 'file.edited', toolCallId: 't1', path: join(external, 'src/x.ts'), action: 'created' })
  log.append('c-both', { type: 'tool.started', toolCallId: 't2', name: 'Bash', input: { command: `cd ${external} && ls` }, parentToolCallId: null })
  log.append('c-root', { type: 'file.edited', toolCallId: 't3', path: join(external, 'src/x.ts'), action: 'modified' })
  assert.equal(db.select().from(conversationPaths).all().length, 2)

  // Previously journaled commands are backfilled only once: late-inserted commands
  // are processed only on the first pass.
  db.delete(conversationPaths).run()
  assert.equal(backfillCommandPaths(db), 1)
  assert.equal(db.select().from(conversationPaths).all().length, 1)
  assert.equal(backfillCommandPaths(db), 0)
  log.append('c-root', { type: 'file.edited', toolCallId: 't4', path: join(external, 'src/x.ts'), action: 'modified' })

  // One-command batches: cursors cross conversations without losing entries.
  log.append('c-direct', { type: 'tool.started', toolCallId: 't5', name: 'Bash', input: { command: `git -C ${known} status` }, parentToolCallId: null })
  db.delete(conversationPaths).run()
  db.run(sql`DELETE FROM app_settings WHERE key = 'worktree_paths_backfill'`)
  assert.equal(backfillCommandPaths(db, 1), 2)
  assert.deepEqual(
    db.select({ id: conversationPaths.conversationId, path: conversationPaths.path }).from(conversationPaths).all()
      .map((row) => `${row.id}:${row.path}`).sort(),
    [`c-both:${external}`, `c-direct:${known}`],
  )
  log.append('c-root', { type: 'file.edited', toolCallId: 't6', path: join(external, 'src/x.ts'), action: 'modified' })

  const first = await service.get(projectRow)
  assert.equal(first.base, 'main')
  assert.equal(first.fresh, true)
  const byPath = new Map(first.worktrees.map((w) => [w.path, w]))
  assert.equal(byPath.size, 3)
  assert.ok(!byPath.has(repo), "l'arbre principal n'est pas un chantier")

  const knownTree = byPath.get(known)!
  assert.deepEqual([knownTree.id, knownTree.external, knownTree.state, knownTree.name], ['wt-known', false, 'merged', 'feat/known'])
  assert.deepEqual(knownTree.conversations.map((c) => c.id).sort(), ['c-both', 'c-direct'])
  assert.ok(knownTree.conversations.every((c) => c.link === 'worktree'))

  const externalTree = byPath.get(external)!
  assert.deepEqual([externalTree.id, externalTree.external, externalTree.branch], [null, true, 'feat/external'])
  assert.deepEqual(externalTree.conversations.map((c) => `${c.id}:${c.link}`).sort(), ['c-both:edited', 'c-root:edited'])
  // Latest activity: the session's own for cwd links (journal appends refresh it), its last write
  // in the tree for edited ones, so a session that wrote in several trees shows the one it touched last.
  const directUpdatedAt = db.select({ updatedAt: conversations.updatedAt }).from(conversations).where(sqlEq(conversations.id, 'c-direct')).get()!.updatedAt
  assert.equal(knownTree.conversations.find((c) => c.id === 'c-direct')?.lastActiveAt, directUpdatedAt)
  const lastWrite = db.select({ ts: sql<number>`max(${conversationPaths.lastTs})` }).from(conversationPaths)
    .where(sqlEq(conversationPaths.conversationId, 'c-root')).get()!.ts
  assert.ok(lastWrite > 1)
  assert.equal(externalTree.conversations.find((c) => c.id === 'c-root')?.lastActiveAt, lastWrite)

  // Git and the disk agree the ghost is gone: Sillage records the removal instead of
  // flagging a tree nobody can act on, while the prunable one stays missing.
  assert.ok(!byPath.has(join(trees, 'ghost')), 'le fantôme ne figure plus dans la liste')
  assert.ok(db.select().from(worktrees).where(sqlEq(worktrees.id, 'wt-ghost')).get()?.removedAt, 'sa suppression est enregistrée')
  assert.equal(db.select().from(worktreeKeptFiles).all().length, 0, 'son choix de fichiers gardés disparaît avec lui')
  const prunable = byPath.get(vanished)!
  assert.deepEqual([prunable.id, prunable.state, prunable.name, prunable.external], ['wt-vanished', 'missing', 'feat/vanished', false])
  assert.equal(db.select().from(worktrees).where(sqlEq(worktrees.id, 'wt-vanished')).get()?.removedAt, null)
  assert.equal(first.worktrees[0]?.id, 'wt-vanished', "l'introuvable passe en tête")

  // Serve cached lists until invalidated; completed turns mark them stale,
  // then return stale lists immediately while refreshing.
  write(known, 'src/app.ts', 'changed\n')
  assert.equal((await service.get(projectRow)).worktrees.find((w) => w.id === 'wt-known')?.state, 'merged')
  log.append('c-direct', { type: 'turn.completed', costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 } as never)
  const stale = await service.get(projectRow)
  assert.equal(stale.fresh, false)
  await new Promise((done) => setTimeout(done, 300))
  const next = await service.get(projectRow)
  assert.equal(next.fresh, true)
  assert.equal(next.worktrees.find((w) => w.id === 'wt-known')?.state, 'dirty')
})

test('une liste git vide ne vaut pas suppression : les entrées restent introuvables', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-worktree-norepo-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  // A workspace git cannot read (not a repository) yields an empty list, as a failing git would.
  const workspace = join(dir, 'plain')
  mkdirSync(workspace)
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: workspace, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const projectRow = db.select().from(projects).where(sqlEq(projects.id, 'project')).get()!
  db.insert(worktrees).values({ id: 'wt-row', projectId: 'project', name: 'feat/row', path: join(dir, 'nowhere'), baseRef: 'HEAD', createdBy: 'owner', createdAt: 1 }).run()

  const list = await new WorktreeStatusService(db, new EventLog(db)).get(projectRow)
  assert.deepEqual(list.worktrees.map((tree) => [tree.id, tree.state]), [['wt-row', 'missing']])
  assert.equal(db.select().from(worktrees).where(sqlEq(worktrees.id, 'wt-row')).get()?.removedAt, null)
})

test('nettoyer : plan puis exécution, arbre connu et arbre externe, branche et sessions', async (t) => {
  const { repo, trees } = repository(t)
  const dir = mkdtempSync(join(tmpdir(), 'sillage-worktree-clean-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: repo, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const projectRow = db.select().from(projects).where(sqlEq(projects.id, 'project')).get()!
  db.insert(cards).values({ id: 'card', projectId: 'project', number: 7, title: 'Squash it', description: '', column: 'in_progress', position: 1, createdBy: 'owner', createdAt: 1, updatedAt: 1 } as never).run()

  const known = addTree(repo, trees, 'feat/known')
  write(known, 'src/k.ts', 'k\n')
  commitAll(known, 'k')
  git(repo, 'merge', '--squash', 'feat/known')
  git(repo, 'commit', '-m', 'squash k')
  db.insert(worktrees).values({ id: 'wt-known', projectId: 'project', name: 'feat/known', path: known, baseRef: 'HEAD', createdBy: 'owner', createdAt: 1 }).run()
  db.insert(conversations).values([
    { id: 'c1', projectId: 'project', userId: 'owner', title: 'one', agent: 'claude', config: '{}', status: 'idle', worktreeId: 'wt-known', cardId: 'card', createdAt: 1, updatedAt: 1 },
    { id: 'c2', projectId: 'project', userId: 'owner', title: 'two', agent: 'claude', config: '{}', status: 'idle', worktreeId: 'wt-known', archivedAt: 1, createdAt: 1, updatedAt: 1 },
  ] as never).run()
  const external = addTree(repo, trees, 'feat/external')
  write(external, 'notes.md', 'keep?\n')

  const log = new EventLog(db)
  const status = new WorktreeStatusService(db, log)
  const closed: string[] = []
  const terminals = { underCwd: () => [] as string[], close: (id: string) => closed.push(id) } as unknown as TerminalManager
  const dropped: string[] = []
  const cleanup = new WorktreeCleanup(db, dir, status, terminals, async (id) => { dropped.push(id) })

  assert.equal(await cleanup.plan(projectRow, join(trees, 'nowhere')), null, 'un chemin hors du projet est refusé')
  assert.equal(await cleanup.plan(projectRow, repo), null, "l'arbre principal n'est pas un chantier")

  const plan = (await cleanup.plan(projectRow, known))!
  assert.deepEqual(
    [plan.state, plan.ahead, plan.branchDeletable, plan.conversations.map((c) => c.id), plan.card?.number],
    ['merged', 1, true, ['c1'], 7],
  )
  const result = (await cleanup.run(projectRow, { path: known, deleteBranch: true, archiveSessions: true, stopServices: true }))!
  assert.deepEqual([result.removed, result.branchDeleted, result.archived], [true, true, 1])
  assert.deepEqual(dropped, ['c1', 'c2'])
  assert.ok(!(await listWorktrees(repo)).some((e) => e.path === known))
  assert.ok(!git(repo, 'branch', '--list', 'feat/known'))
  assert.ok(db.select().from(worktrees).where(sqlEq(worktrees.id, 'wt-known')).get()?.removedAt)
  assert.ok(db.select().from(conversations).where(sqlEq(conversations.id, 'c1')).get()?.archivedAt)
  assert.ok(!(await status.get(projectRow)).worktrees.some((w) => w.path === known))

  // External uncommitted trees: plans disclose this and cleanup can preserve branches.
  const external2 = (await cleanup.plan(projectRow, external))!
  assert.deepEqual([external2.state, external2.untracked, external2.conversations], ['dirty', 1, []])
  const kept = (await cleanup.run(projectRow, { path: external, deleteBranch: false, archiveSessions: true, stopServices: false }))!
  assert.deepEqual([kept.removed, kept.branchDeleted], [true, false])
  assert.equal(git(repo, 'branch', '--list', 'feat/external').trim(), 'feat/external')
  assert.ok(!existsSync(external))

  // Directories already gone: git entries remain and cleanup still removes them.
  const gone = addTree(repo, trees, 'feat/gone')
  rmSync(gone, { recursive: true, force: true })
  const prunable = (await cleanup.run(projectRow, { path: gone, deleteBranch: true, archiveSessions: false, stopServices: false }))!
  assert.deepEqual([prunable.removed, prunable.branchDeleted], [true, true])
  assert.deepEqual((await listWorktrees(repo)).map((e) => e.path), [repo])
})

test('fusionné avec des restes : distinct du non commité, gardé tant que les fichiers ne changent pas', async (t) => {
  const { repo, trees } = repository(t)
  const dir = mkdtempSync(join(tmpdir(), 'sillage-worktree-db-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: repo, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const project = db.select().from(projects).where(sqlEq(projects.id, 'project')).get()!

  // Delivered: committed, merged by fast-forward (no commit ahead), then a demo script left behind.
  const done = addTree(repo, trees, 'feat/done')
  db.insert(worktrees).values({ id: 'wt-done', projectId: 'project', name: 'feat/done', path: done, baseRef: 'main', createdBy: 'owner', createdAt: 1 }).run()
  write(done, 'src/feature.ts', 'export const feature = 1\n')
  commitAll(done, 'feature')
  git(repo, 'merge', '--ff-only', 'feat/done')
  write(done, 'demo/serve.sh', 'echo demo\n')
  write(done, 'src/app.ts', 'export const app = 2\n')

  // Fresh: created after every commit, edits never committed. Same Git picture, still work in progress.
  const fresh = addTree(repo, trees, 'feat/fresh')
  db.insert(worktrees).values({ id: 'wt-fresh', projectId: 'project', name: 'feat/fresh', path: fresh, baseRef: 'main', createdBy: 'owner', createdAt: Date.now() + 60_000 }).run()
  write(fresh, 'src/app.ts', 'export const app = 3\n')

  const raw = await assess(repo, done)
  assert.equal(raw.state, 'dirty')
  assert.equal(raw.commitsInBase, true)
  assert.ok(raw.fingerprint)
  assert.deepEqual(
    raw.files.map((file) => `${file.kind} ${file.path}`).sort(),
    ['modified src/app.ts', 'untracked demo/serve.sh'],
  )

  const service = new WorktreeStatusService(db, new EventLog(db))
  const find = async (path: string) => {
    service.forget('project')
    return (await service.current(project)).worktrees.find((tree) => tree.path === path)!
  }

  const left = await find(done)
  assert.equal(left.state, 'leftovers')
  assert.equal(left.fingerprint, raw.fingerprint)
  assert.equal((await find(fresh)).state, 'dirty')
  assert.equal((await find(fresh)).fingerprint, null)

  // Kept: merged while the same files stay untouched.
  db.insert(worktreeKeptFiles).values({ projectId: 'project', path: done, fingerprint: left.fingerprint!, files: 2, keptBy: 'owner', keptAt: Date.now() }).run()
  const kept = await find(done)
  assert.equal(kept.state, 'merged')
  assert.equal(kept.kept, 2)
  assert.equal(kept.fingerprint, null)

  // A later write, even of the same size, brings the tree back.
  await new Promise((resolve) => setTimeout(resolve, 20))
  write(done, 'demo/serve.sh', 'echo demo\n')
  assert.equal((await find(done)).state, 'leftovers')
  write(done, 'notes.md', 'todo\n')
  const grown = await find(done)
  assert.equal(grown.state, 'leftovers')
  assert.notEqual(grown.fingerprint, left.fingerprint)

  // Committing the rest makes it a plain merge again.
  git(done, 'clean', '-fdq')
  git(done, 'checkout', '--', '.')
  const clean = await find(done)
  assert.equal(clean.state, 'merged')
  assert.equal(clean.kept, 0)
})

test('nettoyage groupé : fusionnés et introuvables partent, le reste est laissé avec sa raison', async (t) => {
  const { repo, trees } = repository(t)
  const dir = mkdtempSync(join(tmpdir(), 'sillage-worktree-bulk-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: repo, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const projectRow = db.select().from(projects).where(sqlEq(projects.id, 'project')).get()!

  const tree = (branch: string, id: string) => {
    const path = addTree(repo, trees, branch)
    db.insert(worktrees).values({ id, projectId: 'project', name: branch, path, baseRef: 'main', createdBy: 'owner', createdAt: 1 }).run()
    return path
  }
  const done = tree('feat/done', 'wt-done')
  const busy = tree('feat/busy', 'wt-busy')
  const wip = tree('feat/wip', 'wt-wip')
  write(wip, 'draft.ts', 'wip\n')
  const gone = tree('feat/gone', 'wt-gone')
  rmSync(gone, { recursive: true, force: true })

  const conversation = (id: string, worktreeId: string | null, status: 'idle' | 'running') => ({
    id, projectId: 'project', userId: 'owner', title: id, agent: 'claude' as const, config: '{}', status, worktreeId, createdAt: 1, updatedAt: 1,
  })
  db.insert(conversations).values([
    conversation('lived', 'wt-done', 'idle'),
    conversation('working', 'wt-busy', 'running'),
    // A running supervisor at the root that wrote in the merged tree: neither blocks nor gets archived.
    conversation('supervisor', null, 'running'),
  ]).run()
  db.insert(conversationPaths).values({ conversationId: 'supervisor', path: join(done, 'src/app.ts'), lastTs: 2 }).run()

  const status = new WorktreeStatusService(db, new EventLog(db))
  const terminals = { underCwd: () => [] as string[], close: () => undefined } as unknown as TerminalManager
  const cleanup = new WorktreeCleanup(db, dir, status, terminals, async () => undefined)
  // A list seen before the user acts: the tree gains work afterwards and must survive.
  await status.get(projectRow)
  const late = tree('feat/late', 'wt-late')
  await status.current(projectRow)
  write(late, 'new.ts', 'new\n')

  const { items } = await cleanup.runMany(projectRow, {
    paths: [done, busy, wip, gone, late, join(trees, 'nowhere')],
    deleteBranch: true, archiveSessions: true, stopServices: false,
  })
  const outcome = Object.fromEntries(items.map((item) => [item.name, item.outcome === 'skipped' ? `skipped:${item.reason}` : item.outcome]))
  assert.deepEqual(outcome, {
    'feat/done': 'removed',
    'feat/busy': 'skipped:busy',
    'feat/wip': 'skipped:changed',
    'feat/gone': 'removed',
    'feat/late': 'skipped:changed',
    [join(trees, 'nowhere')]: 'skipped:not_found',
  })
  const removed = items.find((item) => item.name === 'feat/done')
  assert.ok(removed?.outcome === 'removed' && removed.branchDeleted && removed.archived === 1)

  assert.ok(!existsSync(done) && existsSync(busy) && existsSync(wip) && existsSync(late))
  assert.equal(git(repo, 'branch', '--list', 'feat/done'), '')
  assert.deepEqual((await listWorktrees(repo)).map((entry) => entry.path).sort(), [repo, busy, wip, late].sort())
  for (const id of ['wt-done', 'wt-gone']) assert.ok(db.select().from(worktrees).where(sqlEq(worktrees.id, id)).get()?.removedAt)
  assert.ok(db.select().from(conversations).where(sqlEq(conversations.id, 'lived')).get()?.archivedAt)
  assert.equal(db.select().from(conversations).where(sqlEq(conversations.id, 'supervisor')).get()?.archivedAt, null)
  assert.equal(db.select().from(conversations).where(sqlEq(conversations.id, 'working')).get()?.archivedAt, null)
  assert.deepEqual((await status.get(projectRow)).worktrees.map((entry) => entry.name).sort(), ['feat/busy', 'feat/late', 'feat/wip'])
})

test('a decision reads the tree as git has it now, not as cached before a commit and merge', async (t) => {
  const { repo, trees } = repository(t)
  const dir = mkdtempSync(join(tmpdir(), 'sillage-worktree-fresh-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: repo, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const project = db.select().from(projects).get()!
  const status = new WorktreeStatusService(db, new EventLog(db))
  const state = (list: { worktrees: { path: string; state: string }[] }, path: string) => list.worktrees.find((tree) => tree.path === path)?.state

  // Cached while dirty, then an agent commits and fast-forwards main from its shell: nothing tells
  // the service, and the cache is still within its lifetime.
  const first = addTree(repo, trees, 'fix/first')
  write(first, 'src/first.ts', 'export const first = 1\n')
  assert.equal(state(await status.current(project), first), 'dirty')
  commitAll(first, 'first')
  git(repo, 'merge', '--ff-only', 'fix/first')
  assert.equal(state(await status.current(project), first), 'dirty', 'the cache alone still says dirty')
  assert.equal(state(await status.fresh(project), first), 'merged')

  // A computation already running when the merge lands must not be the one a decision reads.
  const second = addTree(repo, trees, 'fix/second')
  write(second, 'src/second.ts', 'export const second = 2\n')
  status.invalidate(project.id)
  const running = status.get(project)
  commitAll(second, 'second')
  git(repo, 'merge', '--ff-only', 'fix/second')
  await running
  assert.equal(state(await status.fresh(project), second), 'merged')
})
