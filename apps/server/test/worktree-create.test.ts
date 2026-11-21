import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { conversations, openDatabase, projects, runMigrations, users, worktrees } from '@sillage/db'
import type { Config } from '../src/config.js'
import { EventLog } from '../src/events/event-log.js'
import { createWorktree } from '../src/http/routes/worktrees.js'
import { WorktreeStatusService } from '../src/worktrees/status-service.js'

/** Creating a worktree: the database claims the name before git builds the tree, and a removed name can be used again. */

const isolation = mkdtempSync(join(tmpdir(), 'sillage-worktree-create-isolation-'))
writeFileSync(join(isolation, 'gitconfig'), '')
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = join(isolation, 'gitconfig')
for (const name of ['EMAIL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
  delete process.env[name]
}
after(() => rmSync(isolation, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-worktree-create-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'root')
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: repo, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const project = db.select().from(projects).get()!
  const ctx = { db, config: { paths: { worktrees: join(dir, 'worktrees') } } as unknown as Config }
  return { db, repo, project, ctx }
}

test('a removed worktree name can be created again while a conversation still points at the old one', async (t) => {
  const { db, repo, project, ctx } = setup(t)
  const first = await createWorktree(ctx, project, 'owner', 'issue-12', 'main')
  db.insert(conversations).values({ id: 'c', projectId: 'project', userId: 'owner', title: 'Issue 12', agent: 'claude', config: '{}', status: 'idle', worktreeId: first.id, createdAt: 1, updatedAt: 1 }).run()
  // Cleaned after merge, as worktree cleanup does: the entry stays as a tombstone.
  git(repo, 'worktree', 'remove', '--force', first.path)
  git(repo, 'branch', '-D', 'issue-12')
  db.update(worktrees).set({ removedAt: Date.now() }).where(eq(worktrees.id, first.id)).run()

  // A new comment on the issue: the same name again. This used to fail on the foreign key after
  // git had already created the tree, and on "already exists" at every retry.
  const second = await createWorktree(ctx, project, 'owner', 'issue-12', 'main')
  assert.notEqual(second.id, first.id)
  assert.ok(existsSync(second.path))
  assert.equal(db.select().from(conversations).get()!.worktreeId, first.id, 'the old conversation keeps its tree')
  await assert.rejects(createWorktree(ctx, project, 'owner', 'issue-12', 'main'), { code: 'worktree_exists' })
})

test('a git failure gives the name back', async (t) => {
  const { db, project, ctx } = setup(t)
  await assert.rejects(createWorktree(ctx, project, 'owner', 'feat/x', 'no-such-ref'), { code: 'git_failed' })
  assert.equal(db.select().from(worktrees).all().length, 0)
  const created = await createWorktree(ctx, project, 'owner', 'feat/x', 'main')
  assert.ok(existsSync(created.path))
})

test('an entry whose tree git is still building is not taken for a removed one', async (t) => {
  const { db, project } = setup(t)
  db.insert(worktrees).values({ id: 'building', projectId: 'project', name: 'feat/slow', path: join(tmpdir(), 'sillage-not-yet-there'), baseRef: 'main', createdBy: 'owner', createdAt: Date.now() }).run()
  const status = new WorktreeStatusService(db, new EventLog(db))
  const list = await status.current(project)
  assert.equal(list.worktrees.find((tree) => tree.id === 'building'), undefined)
  assert.equal(db.select().from(worktrees).where(eq(worktrees.id, 'building')).get()!.removedAt, null)
})
