import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conversations, openDatabase, projectActions, projects, runMigrations, users } from '@sillage/db'
import { actionUrlSchema, resolveActionUrl } from '@sillage/protocol'
import { ActionRunner, createAction, loadAction, updateAction } from '../src/actions/actions.js'
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
  assert.match(listed.content[0]!.text, /« Tests » \(task, en attente de validation/)
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

  // Une retouche depuis l'interface vaut relecture.
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

  // Relancer remplace l'écran terminé au lieu d'en empiler un second.
  const third = await runner.run(row, dir, null)
  assert.notEqual(third.terminal?.id, first.terminal?.id)
  assert.equal(terminals.list('project').length, 1)
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
