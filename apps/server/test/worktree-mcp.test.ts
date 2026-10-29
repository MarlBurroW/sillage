import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { conversationPaths, conversations, openDatabase, projects, runMigrations, users, worktrees } from '@sillage/db'
import type { AgentRegistry } from '../src/agents/registry.js'
import type { Config } from '../src/config.js'
import { EventLog } from '../src/events/event-log.js'
import { projectOverview } from '../src/agents/overview.js'
import { AgentRequests } from '../src/sessions/agent-requests.js'
import type { SessionManager } from '../src/sessions/session-manager.js'
import type { TerminalManager } from '../src/terminals/terminal-manager.js'
import { WorktreeCleanup } from '../src/worktrees/cleanup.js'
import { linkedWorktreePaths } from '../src/worktrees/linked.js'
import { WorktreeStatusService } from '../src/worktrees/status-service.js'

/** Agent-created worktrees: real MCP subprocess, daemon request sweeps and a real repository. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function harness(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-worktree-mcp-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const repo = join(dir, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git(repo, 'config', 'user.name', 'Worktree test')
  git(repo, 'config', 'user.email', 'worktree@example.test')
  writeFileSync(join(repo, 'README.md'), 'main\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'root')
  // Main worktree remains on another branch; the base must stay main.
  git(repo, 'checkout', '-q', '-b', 'elsewhere')
  writeFileSync(join(repo, 'README.md'), 'elsewhere\n')
  git(repo, 'commit', '-q', '-am', 'elsewhere')

  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: repo, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  db.insert(conversations).values({
    id: 'agent', projectId: 'project', userId: 'owner', title: 'Session', agent: 'claude', config: '{}', status: 'running',
    createdAt: 1, updatedAt: Date.now(),
  }).run()

  const config = { paths: { data: join(dir, 'data'), worktrees: join(dir, 'worktrees') } } as unknown as Config
  const status = new WorktreeStatusService(db, new EventLog(db))
  const terminals = { underCwd: () => [] as string[], close: () => undefined } as unknown as TerminalManager
  const dropped: string[] = []
  const cleanup = new WorktreeCleanup(db, join(dir, 'data'), status, terminals, async (id) => { dropped.push(id) })
  const requests = new AgentRequests(
    { db, config }, {} as SessionManager, {} as AgentRegistry,
    undefined, undefined, undefined, undefined, undefined, status, undefined, undefined, cleanup,
  )

  const rpc = async (message: object) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
      env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: 'project', SILLAGE_MCP_CONVERSATION: 'agent' },
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, ...message }) + '\n')
    const deadline = Date.now() + 20000
    while (!stdout.includes('\n') && Date.now() < deadline) {
      await requests.sweep()
      await new Promise((done) => setTimeout(done, 50))
    }
    child.kill()
    return JSON.parse(stdout).result
  }
  const call = async (name: string, args: object) =>
    (await rpc({ method: 'tools/call', params: { name, arguments: args } })) as { content: { text: string }[]; isError?: boolean }

  return { db, repo, config, rpc, call, dropped }
}

test('les trois outils sont proposés aux sessions', async (t) => {
  const { rpc } = harness(t)
  const { tools } = (await rpc({ method: 'tools/list' })) as { tools: { name: string; inputSchema: { required?: string[] } }[] }
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  assert.deepEqual(byName.create_worktree?.inputSchema.required, ['branch'])
  assert.ok(byName.list_worktrees)
  assert.deepEqual(byName.remove_worktree?.inputSchema.required, ['worktree'])
})

test('create_worktree : depuis la branche par défaut, rattaché sans toucher au cwd', async (t) => {
  const { db, repo, config, call } = harness(t)

  assert.match((await call('list_worktrees', {})).content[0]!.text, /No worktrees/)

  const created = await call('create_worktree', { branch: 'feat/mcp' })
  assert.equal(created.isError, undefined, created.content[0]?.text)
  const path = join(config.paths.worktrees, 'project', 'feat__mcp')
  assert.match(created.content[0]!.text, new RegExp(`ready at ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(created.content[0]!.text, /from main/)
  // Start from main rather than the main worktree's current branch.
  assert.equal(git(path, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'))

  const row = db.select().from(worktrees).where(eq(worktrees.name, 'feat/mcp')).get()!
  assert.equal(row.path, path)
  assert.equal(db.select().from(conversations).where(eq(conversations.id, 'agent')).get()?.worktreeId, null, 'le cwd de la session ne bouge pas')
  assert.deepEqual(db.select({ path: conversationPaths.path }).from(conversationPaths).all(), [{ path }])
  assert.deepEqual(linkedWorktreePaths(db, 'agent', 'project'), [path])

  // Requesting the same tree returns it unchanged.
  const again = await call('create_worktree', { branch: 'feat/mcp' })
  assert.equal(again.isError, undefined)
  assert.match(again.content[0]!.text, /Already existed/)

  // Branches checked out elsewhere cannot be checked out twice: git rejects them and
  // explain this plainly to the agent.
  const busy = await call('create_worktree', { branch: 'elsewhere' })
  assert.equal(busy.isError, true)
  assert.match(busy.content[0]!.text, /déjà extraite/)

  // Reuse available existing branches instead of recreating them from the base.
  git(repo, 'branch', 'feat/kept', 'elsewhere')
  const reused = await call('create_worktree', { branch: 'feat/kept' })
  assert.equal(reused.isError, undefined, reused.content[0]?.text)
  assert.match(reused.content[0]!.text, /reused as-is/)
  assert.equal(git(join(config.paths.worktrees, 'project', 'feat__kept'), 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'elsewhere'))

  const listed = (await call('list_worktrees', {})).content[0]!.text
  assert.match(listed, /compared with main/)
  assert.match(listed, /`feat\/mcp` : merged/)
  assert.match(listed, /you worked here/)
})

test('create_worktree refuse un nom ou une base qui serait lu comme autre chose', async (t) => {
  const { call } = harness(t)
  const missing = await call('create_worktree', {})
  assert.equal(missing.isError, true)
  assert.match(missing.content[0]!.text, /`branch` parameter is required/)

  const traversal = await call('create_worktree', { branch: 'feat/../escape' })
  assert.equal(traversal.isError, true)
  assert.match(traversal.content[0]!.text, /Invalid worktree name/)

  const option = await call('create_worktree', { branch: 'feat/option', base: '--detach' })
  assert.equal(option.isError, true)
  assert.match(option.content[0]!.text, /Invalid base/)
})

test('remove_worktree : fusionné sans force, tout le reste avec force, jamais son propre arbre', async (t) => {
  const { db, repo, config, call, dropped } = harness(t)
  const missing = await call('remove_worktree', {})
  assert.equal(missing.isError, true)
  assert.match(missing.content[0]!.text, /`worktree` parameter is required/)

  const unknown = await call('remove_worktree', { worktree: 'feat/nowhere' })
  assert.equal(unknown.isError, true)
  assert.match(unknown.content[0]!.text, /No worktree “feat\/nowhere”/)

  // Merged tree created through Sillage: removed with its branch, and the requester,
  // attached only by having created it, is left alone.
  assert.equal((await call('create_worktree', { branch: 'feat/done' })).isError, undefined)
  const done = join(config.paths.worktrees, 'project', 'feat__done')
  const removed = await call('remove_worktree', { worktree: 'feat/done' })
  assert.equal(removed.isError, undefined, removed.content[0]?.text)
  assert.match(removed.content[0]!.text, /Worktree “feat\/done” removed/)
  assert.match(removed.content[0]!.text, /Branch “feat\/done” deleted/)
  assert.ok(!existsSync(done))
  assert.ok(!git(repo, 'branch', '--list', 'feat/done'))
  assert.ok(db.select().from(worktrees).where(eq(worktrees.name, 'feat/done')).get()?.removedAt)
  assert.equal(db.select().from(conversations).where(eq(conversations.id, 'agent')).get()?.archivedAt, null)
  assert.deepEqual(dropped, [])
  assert.match((await call('list_worktrees', {})).content[0]!.text, /No worktrees/)

  // Uncommitted work is refused and described; `force` removes it but keeps the branch.
  assert.equal((await call('create_worktree', { branch: 'feat/wip' })).isError, undefined)
  const wip = join(config.paths.worktrees, 'project', 'feat__wip')
  writeFileSync(join(wip, 'draft.ts'), 'wip\n')
  const refused = await call('remove_worktree', { worktree: 'feat/wip' })
  assert.equal(refused.isError, true)
  assert.match(refused.content[0]!.text, /Refused: “feat\/wip” is uncommitted \(1 untracked file\(s\)\)/)
  assert.match(refused.content[0]!.text, /force: true/)
  assert.ok(existsSync(wip))
  const forced = await call('remove_worktree', { worktree: wip, force: true })
  assert.equal(forced.isError, undefined, forced.content[0]?.text)
  assert.match(forced.content[0]!.text, /Branch “feat\/wip” kept/)
  assert.ok(!existsSync(wip))
  assert.equal(git(repo, 'branch', '--list', 'feat/wip'), 'feat/wip')

  // Sessions that lived in the tree: a working one blocks, a finished one is archived.
  assert.equal((await call('create_worktree', { branch: 'feat/lived' })).isError, undefined)
  const livedId = db.select().from(worktrees).where(eq(worktrees.name, 'feat/lived')).get()!.id
  db.insert(conversations).values([
    { id: 'busy', projectId: 'project', userId: 'owner', title: 'Busy', agent: 'claude', config: '{}', status: 'running', worktreeId: livedId, createdAt: 1, updatedAt: 1 },
    { id: 'idle', projectId: 'project', userId: 'owner', title: 'Idle', agent: 'claude', config: '{}', status: 'idle', worktreeId: livedId, createdAt: 1, updatedAt: 1 },
  ]).run()
  const blocked = await call('remove_worktree', { worktree: 'feat/lived' })
  assert.equal(blocked.isError, true)
  assert.match(blocked.content[0]!.text, /“Busy” is still working in this tree/)
  db.update(conversations).set({ status: 'idle' }).where(eq(conversations.id, 'busy')).run()
  const archived = await call('remove_worktree', { worktree: 'feat/lived' })
  assert.equal(archived.isError, undefined, archived.content[0]?.text)
  assert.match(archived.content[0]!.text, /2 session\(s\) that lived there archived/)
  assert.ok(db.select().from(conversations).where(eq(conversations.id, 'idle')).get()?.archivedAt)
  assert.deepEqual(dropped.sort(), ['busy', 'idle'])

  // The requester's own tree stays: its cwd would vanish underneath it.
  assert.equal((await call('create_worktree', { branch: 'feat/home' })).isError, undefined)
  const homeId = db.select().from(worktrees).where(eq(worktrees.name, 'feat/home')).get()!.id
  db.update(conversations).set({ worktreeId: homeId }).where(eq(conversations.id, 'agent')).run()
  const own = await call('remove_worktree', { worktree: 'feat/home' })
  assert.equal(own.isError, true)
  assert.match(own.content[0]!.text, /your session works in this tree/)
  assert.ok(existsSync(join(config.paths.worktrees, 'project', 'feat__home')))
})

test('le prompt dynamique cite les trois outils quand d’autres sessions travaillent dans le projet', async (t) => {
  const { db } = harness(t)
  db.insert(conversations).values({
    id: 'other', projectId: 'project', userId: 'owner', title: 'Voisine', agent: 'codex', config: '{}', status: 'running',
    createdAt: 1, updatedAt: Date.now(),
  }).run()
  const overview = projectOverview(db, { projectId: 'project', conversationId: 'agent', sillageMcp: true }) ?? ''
  assert.match(overview, /`list_worktrees`, `create_worktree` and `remove_worktree` to work separately from others and clean up after a merge instead of using `git worktree add` or `remove`/)
})
