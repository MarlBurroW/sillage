import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { conversations, openDatabase, runMigrations, users } from '@sillage/db'
import { defaultConfigFor, type AgentKind } from '@sillage/protocol'
import { CachedProbe, CachedProbeMap } from '../src/agents/cached-probe.js'
import { CliInstaller } from '../src/agents/cli-install.js'
import { CliBinary } from '../src/agents/cli-binary.js'
import { AgentRegistry, type AgentAdapter } from '../src/agents/registry.js'
import type { AgentRunner, RunnerContext } from '../src/agents/types.js'
import { loadConfig } from '../src/config.js'
import { createConversation } from '../src/conversations/create.js'
import { createPersonalWorkspace } from '../src/conversations/personal-workspaces.js'
import { EventLog } from '../src/events/event-log.js'
import { registerAgentRoutes } from '../src/http/routes/agents.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { SessionManager } from '../src/sessions/session-manager.js'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate() && Date.now() < deadline) await delay(10)
  assert.ok(predicate(), 'Expected background transition')
}

class TestInstaller extends CliInstaller {
  installCalls: AgentKind[] = []
  run = async (_kind: AgentKind) => {}
  protected override async install(kind: AgentKind): Promise<void> {
    this.installCalls.push(kind)
    await this.run(kind)
  }
}

test('CLI updates wait for activity, serialize the shared prefix and allow queued cancellation', async (t) => {
  let busy = true
  const released: AgentKind[] = []
  const finished = deferred()
  const installer = new TestInstaller('/unused', {
    acquire: async (kind) => kind === 'codex' && busy ? null : () => { released.push(kind) },
  })
  t.after(() => installer.close())
  installer.run = async (kind) => { if (kind === 'claude') await finished.promise }
  assert.equal(installer.start('codex'), true)
  await until(() => installer.state('codex').status === 'queued')
  await delay(0)
  assert.deepEqual(installer.installCalls, [])
  assert.equal(installer.start('codex'), false)
  installer.start('claude')
  await until(() => installer.state('claude').status === 'running')
  installer.start('grok')
  assert.equal(installer.cancel('grok'), true)
  assert.equal(installer.cancel('claude'), false)
  busy = false
  finished.resolve()
  await until(() => installer.state('codex').status === 'idle')
  assert.deepEqual(installer.installCalls, ['claude', 'codex'])
  assert.deepEqual(released, ['claude', 'codex'])
})

test('Verification failures are visible, release the CLI and can be retried', async (t) => {
  let verify = false
  let releases = 0
  const installer = new TestInstaller('/unused', {
    acquire: async () => () => { releases++ },
    onInstalled: async () => { if (!verify) throw new Error('Wrong version after installation') },
  })
  t.after(() => installer.close())
  installer.start('codex')
  await until(() => installer.state('codex').status === 'failed')
  assert.match(JSON.stringify(installer.state('codex')), /Wrong version/)
  assert.equal(releases, 1)
  verify = true
  installer.start('codex')
  await until(() => installer.state('codex').status === 'idle')
  assert.equal(releases, 2)
})

test('Invalidation cannot resurrect an old catalog from an in-flight probe and clears every account', async () => {
  const old = deferred<{ version: number }>()
  let calls = 0
  const cache = new CachedProbe(60_000, () => ++calls === 1 ? old.promise : Promise.resolve({ version: 2 }))
  const initial = cache.read()
  cache.invalidate()
  assert.equal((await cache.read()).version, 2)
  old.resolve({ version: 1 })
  await initial
  assert.equal((await cache.read()).version, 2)
  let version = 1
  const accounts = new CachedProbeMap(60_000, async () => ({ version }))
  await accounts.read('host')
  await accounts.read('personal')
  version = 2
  accounts.invalidate()
  assert.equal((await accounts.read('host')).version, 2)
  assert.equal((await accounts.read('personal')).version, 2)
})

test('Installation routes require admin rights and refuse disabled, custom and newer executables', async (t) => {
  let version = '0.146.0'
  let installable = true
  const adapter = { kind: 'codex', label: 'Codex', cli: {
    get installable() { return installable }, describe: async () => ({ version }),
  } } as unknown as AgentAdapter
  const installer = new TestInstaller('/unused', { acquire: async () => null })
  const app = Fastify()
  app.addHook('preHandler', async (request) => { request.user = { isAdmin: request.headers['x-admin'] === '1' } as never })
  registerErrorHandler(app)
  registerAgentRoutes(app, {} as never, new AgentRegistry([adapter]), installer, {} as never, {} as never, {} as never, {} as never)
  t.after(async () => { installer.close(); await app.close() })
  const install = (admin = true) => app.inject({ method: 'POST', url: '/api/agents/codex/install', headers: admin ? { 'x-admin': '1' } : {} })
  assert.equal((await install(false)).statusCode, 403)
  installable = false
  assert.equal((await install()).json().error.code, 'cli_install_unmanaged')
  installable = true
  version = '9.0.0'
  assert.equal((await install()).json().error.code, 'cli_newer_version')
  version = '0.146.0'
  assert.equal((await install()).statusCode, 202)
  assert.equal((await install()).statusCode, 409)
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/agents/codex/install' })).statusCode, 403)
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/agents/codex/install', headers: { 'x-admin': '1' } })).statusCode, 204)
  assert.deepEqual(installer.installCalls, [])
  assert.equal(new CliBinary('codex', 'Codex', 'C:\\Tools\\codex.exe', true, '/unused').installable, false)
  assert.equal(new CliBinary('codex', 'Codex', 'codex', true, '/unused').installable, true)
  assert.equal(new CliBinary('codex', 'Codex', 'codex', false, '/unused').installable, false)
})

test('Session maintenance waits for startup, turns, questions and detached work, then resumes on a fresh runner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sillage-cli-maintenance-'))
  const { db, sqlite } = openDatabase(join(root, 'test.db'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'user', username: 'user', displayName: 'User', passwordHash: '', createdAt: 1 }).run()
  const workspace = createPersonalWorkspace(db, root, 'user', 'Test')
  db.insert(conversations).values({ id: 'conversation', userId: 'user', workspaceId: workspace.id, title: 'Test', status: 'idle', agent: 'codex', config: JSON.stringify(defaultConfigFor('codex')), createdAt: 1, updatedAt: 1 }).run()
  const config = loadConfig()
  config.paths = { ...config.paths, data: root, agents: join(root, 'agents'), memory: join(root, 'memory') }
  const startup = deferred()
  const contexts: RunnerContext[] = []
  let stops = 0
  let sent = 0
  const adapter = {
    kind: 'codex', label: 'Codex', binary: 'sillage-test-no-cli', rawFormat: 'test',
    cli: { managedDir: config.paths.agents, assertEnabled() {} },
    createRunner(ctx: RunnerContext) {
      contexts.push(ctx)
      return {
        appliedConfig: ctx.config,
        async start() { await startup.promise; ctx.setAgentSessionId('native-session') },
        async send() { sent++; ctx.setStatus('running') },
        async stop() { stops++ },
      } as AgentRunner
    },
  } as unknown as AgentAdapter
  const sessions = new SessionManager(db, new EventLog(db), config, new AgentRegistry([adapter]), {} as never, {} as never, {} as never, {} as never, {} as never)
  t.after(async () => { await sessions.stopAll(); sqlite.close(); await rm(root, { recursive: true, force: true }) })
  const send = sessions.sendMessage('conversation', 'first', 'hello')
  await until(() => contexts.length > 0)
  assert.equal(await sessions.prepareCliUpdate('codex'), null, 'startup must not be interrupted')
  startup.resolve()
  await send
  // Delivery is detached from the send: wait for the hand-over before touching the status.
  await until(() => sent === 1)
  assert.equal(await sessions.prepareCliUpdate('codex'), null, 'active turn')
  const ctx = contexts[0]!
  ctx.setStatus('awaiting_input')
  assert.equal(await sessions.prepareCliUpdate('codex'), null, 'pending question')
  ctx.setStatus('idle')
  ctx.emit({ type: 'background.updated', tasks: [{ id: 'background' }] } as never)
  assert.equal(await sessions.prepareCliUpdate('codex'), null, 'background task')
  ctx.emit({ type: 'background.updated', tasks: [] })
  ctx.emit({ type: 'loops.updated', loops: [{ id: 'loop' }] } as never)
  assert.equal(await sessions.prepareCliUpdate('codex'), null, 'armed loop')
  ctx.emit({ type: 'loops.updated', loops: [] })
  const release = await sessions.prepareCliUpdate('codex')
  assert.ok(release)
  assert.equal(stops, 1)
  await assert.rejects(sessions.sendMessage('conversation', 'retry', 'hello again'), { code: 'cli_updating' })
  release()
  await sessions.sendMessage('conversation', 'retry', 'hello again')
  assert.equal(contexts.length, 2)
  assert.equal(contexts[1]?.resumeSessionId, 'native-session')
})

test('Disabled CLIs are refused before anything is journaled or spawned', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sillage-cli-disabled-'))
  const { db, sqlite } = openDatabase(join(root, 'test.db'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'user', username: 'user', displayName: 'User', passwordHash: '', createdAt: 1 }).run()
  const workspace = createPersonalWorkspace(db, root, 'user', 'Test')
  db.insert(conversations).values({ id: 'conversation', userId: 'user', workspaceId: workspace.id, title: 'Test', status: 'idle', agent: 'claude', config: JSON.stringify(defaultConfigFor('claude')), createdAt: 1, updatedAt: 1 }).run()
  const config = loadConfig()
  config.paths = { ...config.paths, data: root, agents: join(root, 'agents'), memory: join(root, 'memory') }
  let runners = 0
  const adapter = {
    kind: 'claude', label: 'Claude Code', binary: 'sillage-test-no-cli', rawFormat: 'test',
    cli: new CliBinary('claude', 'Claude Code', 'sillage-test-no-cli', false, config.paths.agents),
    createRunner() { runners++; throw new Error('A disabled CLI must never be launched') },
  } as unknown as AgentAdapter
  const log = new EventLog(db)
  const sessions = new SessionManager(db, log, config, new AgentRegistry([adapter]), {} as never, {} as never, {} as never, {} as never, {} as never)
  t.after(async () => { await sessions.stopAll(); sqlite.close(); await rm(root, { recursive: true, force: true }) })

  await assert.rejects(sessions.sendMessage('conversation', 'first', 'hello'), { statusCode: 503, code: 'cli_disabled' })
  await assert.rejects(createConversation(db, sessions, {
    projectId: null, workspaceId: workspace.id, userId: 'user', agent: 'claude', config: defaultConfigFor('claude'),
    worktreeId: null, cardId: null, origin: null,
    firstMessage: { clientMessageId: 'new', text: 'hello', attachments: [], mentions: [], skills: [] },
  }), { code: 'cli_disabled' })
  assert.equal(runners, 0)
  // Catalogs and usage gauges launch through `executable()`, outside sessions.
  await assert.rejects((adapter.cli as CliBinary).executable(), { code: 'cli_disabled' })
  assert.equal(log.read('conversation', 0, 100).length, 0, 'the refused message must not be journaled')
  assert.equal(db.select().from(conversations).all().length, 1, 'no conversation row for a disabled CLI')
})
