import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conversations, openDatabase, runMigrations, users } from '@sillage/db'
import { defaultConfigFor, type SillageEvent } from '@sillage/protocol'
import type { RunnerContext } from '../src/agents/types.js'
import { captureSnapshot, checkpointRef, readSnapshot, restoreSnapshot } from '../src/checkpoints.js'
import { loadConfig } from '../src/config.js'
import { createPersonalWorkspace } from '../src/conversations/personal-workspaces.js'
import { EventLog } from '../src/events/event-log.js'
import { fakeAdapter, fakeRunner, makeSessionManager } from './session-support.js'

/** Restoring a turn rewrites a whole directory: it must keep what it replaces and not run under another session's feet. */

const isolation = mkdtempSync(join(tmpdir(), 'sillage-restore-isolation-'))
writeFileSync(join(isolation, 'gitconfig'), '')
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = join(isolation, 'gitconfig')
for (const name of ['EMAIL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
  delete process.env[name]
}
after(() => rmSync(isolation, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const KEY = 'aaaaaaaa-1111'

async function until(predicate: () => boolean) {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(predicate())
}

test('a restoration refuses while another session works there, keeps what it replaces, and can be undone', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sillage-restore-'))
  const { db, sqlite } = openDatabase(join(root, 'test.db'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'user', username: 'user', displayName: 'User', passwordHash: '', createdAt: 1 }).run()
  const workspace = createPersonalWorkspace(db, root, 'user', 'Repo')
  const repo = workspace.path
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(repo, 'a.txt'), 'before the turn\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'root')
  for (const id of ['a', 'b']) {
    db.insert(conversations).values({ id, userId: 'user', workspaceId: workspace.id, title: id, status: 'idle', agent: 'codex', config: JSON.stringify(defaultConfigFor('codex')), createdAt: 1, updatedAt: 1 }).run()
  }

  const config = loadConfig()
  config.paths = { ...config.paths, data: root, agents: join(root, 'agents'), memory: join(root, 'memory') }
  const contexts = new Map<string, RunnerContext>()
  const adapter = fakeAdapter('codex', config.paths.agents, (ctx) => {
    contexts.set(ctx.conversationId, ctx)
    return fakeRunner(ctx)
  })
  const log = new EventLog(db)
  const sessions = makeSessionManager({ db, log, config, adapters: [adapter] })
  t.after(async () => { await sessions.stopAll(); sqlite.close(); rmSync(root, { recursive: true, force: true }) })

  // Turn of A: captured before, then it edits a file and creates one.
  await captureSnapshot(repo, checkpointRef('a', KEY, 'before'))
  writeFileSync(join(repo, 'a.txt'), 'written by the turn\n')
  writeFileSync(join(repo, 'new.txt'), 'created by the turn\n')
  // Later work nobody captured: the user's own file, as a restoration used to lose for good.
  writeFileSync(join(repo, 'mine.txt'), 'typed after the turn\n')

  // B works in the same directory: its files must not change under it.
  await sessions.sendMessage('b', 'busy', 'work')
  await until(() => contexts.get('b') !== undefined)
  await until(() => db.select().from(conversations).all().find((row) => row.id === 'b')?.status === 'running')
  await assert.rejects(sessions.restoreCheckpoint('a', KEY), { code: 'checkpoint_workspace_busy' })
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'written by the turn\n')
  // B's delivery is detached and waits for its own turn capture: let it hand over, then end its turn.
  const deliveries = (sessions as unknown as { pendingDeliveries: Map<string, unknown> }).pendingDeliveries
  await until(() => !deliveries.has('b'))
  contexts.get('b')!.setStatus('idle')

  const restored = await sessions.restoreCheckpoint('a', KEY)
  assert.equal(restored.skipped, 0)
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'before the turn\n')
  assert.ok(!existsSync(join(repo, 'new.txt')))
  assert.ok(!existsSync(join(repo, 'mine.txt')))
  assert.ok(await readSnapshot(repo, checkpointRef('a', KEY, 'undo')), 'the replaced state is kept')

  // Undo puts back everything the restoration replaced, the uncaptured file included.
  await sessions.restoreCheckpoint('a', KEY, { undo: true })
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'written by the turn\n')
  assert.equal(readFileSync(join(repo, 'mine.txt'), 'utf8'), 'typed after the turn\n')
  assert.ok(existsSync(join(repo, 'new.txt')))

  const journal = log.read('a', 0, 100).map((entry) => entry.event).filter((event): event is Extract<SillageEvent, { type: 'checkpoint.restored' }> => event.type === 'checkpoint.restored')
  assert.deepEqual(journal.map((event) => [event.undoable, event.undone]), [[true, false], [false, true]])
})

test('a path that resists deletion does not stop the restoration halfway', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'sillage-restore-partial-'))
  t.after(() => { chmodSync(join(repo, 'locked'), 0o755); rmSync(repo, { recursive: true, force: true }) })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'before\n')
  git(repo, 'add', '-A')
  git(repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'root')
  await captureSnapshot(repo, checkpointRef('c', KEY, 'before'))
  writeFileSync(join(repo, 'a.txt'), 'after\n')
  mkdirSync(join(repo, 'locked'))
  writeFileSync(join(repo, 'locked', 'stuck.txt'), 'cannot be removed\n')
  writeFileSync(join(repo, 'z.txt'), 'removable\n')
  chmodSync(join(repo, 'locked'), 0o555)

  const result = await restoreSnapshot(repo, checkpointRef('c', KEY, 'before'))
  assert.equal(result.skipped, 1)
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'before\n')
  assert.ok(!existsSync(join(repo, 'z.txt')), 'paths after the stuck one are still removed')
})
