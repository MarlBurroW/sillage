import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conversations, openDatabase, projectActions, projects, runMigrations, users } from '@sillage/db'
import { actionUrlSchema, resolveActionUrl, resolveAgentTools } from '@sillage/protocol'
import { ActionRunner, createAction, loadAction, updateAction, worktreeOf } from '../src/actions/actions.js'
import { liveSessionContext } from '../src/agents/overview.js'
import type { AgentRegistry } from '../src/agents/registry.js'
import type { Config } from '../src/config.js'
import type { SessionManager } from '../src/sessions/session-manager.js'
import { AgentRequests } from '../src/sessions/agent-requests.js'
import { TerminalManager } from '../src/terminals/terminal-manager.js'

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-actions-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())

  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  db.insert(conversations).values({
    id: 'agent', projectId: 'project', userId: 'owner', title: 'Session', agent: 'claude', config: '{}', status: 'running',
    createdAt: 1, updatedAt: Date.now(),
  }).run()

  const config = {
    paths: { data: join(dir, 'data'), worktrees: join(dir, 'worktrees') },
    limits: { ptyIdleTimeoutMin: 5 },
  } as unknown as Config
  const terminals = new TerminalManager(config)
  t.after(() => terminals.shutdown())
  const runner = new ActionRunner(db, config, terminals)
  const requests = new AgentRequests({ db, config }, {} as SessionManager, {} as AgentRegistry, runner)

  const mcp = async (name: string, args: object) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
      env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: 'project', SILLAGE_MCP_CONVERSATION: 'agent' },
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n')
    const deadline = Date.now() + 10000
    while (!stdout.includes('\n') && Date.now() < deadline) {
      await requests.sweep()
      await new Promise((done) => setTimeout(done, 50))
    }
    child.kill()
    return JSON.parse(stdout).result as { content: { text: string }[]; isError?: boolean }
  }

  return { db, dir, terminals, runner, mcp }
}

test('an action registered by an agent waits for review, and listing shows it', async (t) => {
  const { db, mcp } = await harness(t)

  const created = await mcp('register_action', { label: 'Tests', kind: 'task', command: 'pnpm test' })
  assert.equal(created.isError, undefined, created.content[0]?.text)
  const row = db.select().from(projectActions).get()!
  assert.equal(row.approvedAt, null)
  assert.equal(row.agentConversationId, 'agent')

  const listed = await mcp('list_actions', {})
  assert.match(listed.content[0]!.text, /« Tests » \(task, awaiting user approval/)
})

test('an agent renaming keeps the review, changing the command drops it', async (t) => {
  const { db } = await harness(t)
  const row = createAction(db, 'project', { label: 'Dev', kind: 'service', command: 'pnpm dev' }, null)
  assert.ok(row.approvedAt)

  const renamed = updateAction(db, row, { label: 'Serveur de dev' }, 'agent')
  assert.ok(renamed.approvedAt)
  const changed = updateAction(db, renamed, { command: 'pnpm dev --host' }, 'agent')
  assert.equal(changed.approvedAt, null)
  assert.equal(loadAction(db, row.id).approvedAt, null)

  // UI edits count as review.
  assert.ok(updateAction(db, changed, { command: 'pnpm dev' }, null).approvedAt)
})

test('register_action refuses a directory outside the project', async (t) => {
  const { mcp } = await harness(t)
  const result = await mcp('register_action', { label: 'X', kind: 'task', command: 'ls', subdir: '../elsewhere' })
  assert.equal(result.isError, true)
  assert.match(result.content[0]!.text, /subdir/)
})

test('a task runs in its own terminal, keeps its exit code, and is not doubled while running', async (t) => {
  const { db, dir, terminals, runner } = await harness(t)
  await mkdir(join(dir, 'sub'))
  const previousShell = process.env.SHELL
  process.env.SHELL = '/bin/sh'
  t.after(() => { process.env.SHELL = previousShell })

  const row = createAction(db, 'project', { label: 'Pwd', kind: 'task', command: 'sleep 0.3; pwd; exit 3', subdir: 'sub' }, null)
  const first = await runner.run(row, dir, null)
  assert.equal(first.alreadyRunning, false)
  assert.equal(first.terminal?.title, 'Pwd')
  assert.equal(first.terminal?.cwd, join(dir, 'sub'))

  const second = await runner.run(row, dir, null)
  assert.equal(second.alreadyRunning, true)
  assert.equal(second.terminal?.id, first.terminal?.id)

  const deadline = Date.now() + 5000
  while (terminals.latestForAction('project', row.id)?.alive && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 50))
  }
  const done = terminals.latestForAction('project', row.id)!
  assert.equal(done.exitCode, 3)

  // Relaunching replaces finished screens instead of stacking another.
  const third = await runner.run(row, dir, null)
  assert.notEqual(third.terminal?.id, first.terminal?.id)
  assert.equal(terminals.list('project').length, 1)
})

test('an agent reads the output of the latest run, waiting for it to finish', async (t) => {
  const { db, dir, terminals, mcp } = await harness(t)
  const previousShell = process.env.SHELL
  process.env.SHELL = '/bin/sh'
  t.after(() => { process.env.SHELL = previousShell })

  const row = createAction(db, 'project', { label: 'Tests', kind: 'task', command: "printf '\\033[31mboom\\033[0m\\n'; sleep 0.5; exit 2" }, null)
  const never = await mcp('read_action_output', { id: row.id })
  assert.equal(never.isError, undefined, never.content[0]?.text)
  assert.match(never.content[0]!.text, /no run to read/)

  // A user click: the agent did not start it.
  const runner = new ActionRunner(db, { paths: { data: join(dir, 'data') } } as unknown as Config, terminals)
  await runner.run(row, dir, null)
  const waited = await mcp('read_action_output', { id: row.id, wait: 5 })
  const text = waited.content[0]!.text
  assert.match(text, /“Tests” \(task\): failed \(exit 2\)/)
  assert.match(text, /\nboom\n/)
  assert.doesNotMatch(text, /\x1b/)
  assert.match(text, /\[exit 2\]/)

  const refused = await mcp('read_action_output', { id: row.id, wait: 600 })
  assert.equal(refused.isError, true)
  assert.match(refused.content[0]!.text, /`wait` must be an integer from 0 to 45/)
})

test('a restart without systemd runs in the previous worktree, not in its subdirectory twice', () => {
  assert.equal(worktreeOf('/w/tree/apps/web', 'apps/web'), '/w/tree')
  assert.equal(worktreeOf('/w/tree/apps/web', './apps/web/'), '/w/tree')
  assert.equal(worktreeOf('/w/tree', null), '/w/tree')
})

test('the launch context asks agents to propose actions, then lists them', async (t) => {
  const { db } = await harness(t)
  const context = (families: ReturnType<typeof resolveAgentTools> | null = null) =>
    liveSessionContext(db, { projectId: 'project', conversationId: 'agent', sillageMcp: true, activity: true, families }) ?? ''

  assert.match(context(), /This project has no actions yet/)
  assert.match(context(), /propose it with `register_action` without waiting to be asked/)

  const tests = createAction(db, 'project', { label: 'Tests', kind: 'task', command: 'pnpm test' }, null)
  const dev = createAction(db, 'project', { label: 'Dev', kind: 'service', command: 'pnpm dev' }, 'agent')
  const listed = context()
  assert.doesNotMatch(listed, /no actions yet/)
  assert.match(listed, new RegExp(`“Tests” \\(task, id ${tests.id}\\)`))
  assert.match(listed, new RegExp(`“Dev” \\(service, id ${dev.id}, awaiting the user's review\\)`))
  assert.match(listed, /`read_action_output`/)

  // A project that turned the family off is not asked to propose or use them.
  const off = context({ ...resolveAgentTools({}, null), actions: false })
  assert.match(off, /turned off: Project actions/)
  assert.doesNotMatch(off, /Project actions, one-click buttons|no actions yet/)
})

test('an action whose directory is gone says so instead of running elsewhere', async (t) => {
  const { db, dir, runner } = await harness(t)
  const row = createAction(db, 'project', { label: 'X', kind: 'task', command: 'ls', subdir: 'missing' }, null)
  await assert.rejects(runner.run(row, dir, null), /does not exist/)
})

test('a service URL fills in the port it listens on, and an agent changing it asks for review again', async (t) => {
  const { db } = await harness(t)
  assert.equal(resolveActionUrl('http://host:{port}/', [5173, 24678]), 'http://host:5173/')
  assert.equal(resolveActionUrl('http://host:{port}/', []), null)
  assert.equal(resolveActionUrl('https://demo.example', []), 'https://demo.example')
  assert.equal(actionUrlSchema.safeParse('javascript:alert(1)').success, false)
  assert.equal(actionUrlSchema.safeParse('http://host:{port}').success, true)

  const row = createAction(db, 'project', { label: 'Dev', kind: 'service', command: 'pnpm dev', url: 'http://host:{port}' }, null)
  assert.equal(updateAction(db, row, { url: 'http://elsewhere:{port}' }, 'agent').approvedAt, null)
})
