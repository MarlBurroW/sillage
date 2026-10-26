import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { apiTokens, scheduledTasks, conversations, openDatabase, projects, runMigrations, users } from '@sillage/db'
import { DEFAULT_CONFIGS, apiExecutionPolicySchema, type AgentConfig, type AgentModelsDto, type ApiExecutionPolicy, type ApiScope } from '@sillage/protocol'
import { bearerSecret, createApiToken, resolveApiToken } from '../src/auth/api-tokens.js'
import { TOOL_OPERATIONS } from '../src/http/v1/tool-operations.js'
import { registerV1Routes } from '../src/http/v1/index.js'
import { registerApiTokenRoutes } from '../src/http/routes/api-tokens.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { EventLog } from '../src/events/event-log.js'
import { AgentRequests } from '../src/sessions/agent-requests.js'
import type { AgentRegistry } from '../src/agents/registry.js'
import type { SessionManager } from '../src/sessions/session-manager.js'
import type { WebhookService } from '../src/webhooks/service.js'
import type { Config } from '../src/config.js'

const policy: ApiExecutionPolicy = { agents: [
  { agent: 'claude', models: ['alpha', 'beta'], efforts: ['low', 'medium'], maxBudgetUsd: 2 },
  { agent: 'codex', models: ['code'], efforts: ['high'], maxBudgetUsd: null },
] }
const scopes: ApiScope[] = ['projects:read', 'tasks:read', 'tasks:write', 'mcp']
const catalogs = (agent: string): AgentModelsDto => ({
  models: (agent === 'claude' ? ['alpha', 'beta', 'expensive'] : ['code']).map((value, index) => ({
    value, displayName: value.toUpperCase(), isDefault: index === 0, description: '', hint: null, supportsFastMode: false,
    defaultEffort: 'medium', efforts: ['low', 'medium', 'high'].map((value) => ({ value, label: value, hint: null })),
  })), outputStyles: [],
})

async function harness(t: TestContext, options: { policy?: ApiExecutionPolicy | null; scopes?: ApiScope[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-api-policy-'))
  const database = join(dir, 'test.db')
  const { db, sqlite } = openDatabase(database)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'Owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'Project', workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const initial = { ...DEFAULT_CONFIGS.claude, model: 'alpha', effort: 'medium' as const }
  const { row: token, secret } = createApiToken(db, { userId: 'owner', label: 'External client', scopes: options.scopes ?? scopes,
    projectIds: ['project'], agent: 'claude', config: initial, executionPolicy: options.policy === undefined ? policy : options.policy, expiresAt: null, webhookUrl: null })
  let offline = false
  const sent: string[] = []
  const sessions = { statusBus: new EventEmitter(),
    modelsFor: async (_user: string, config: AgentConfig) => { if (offline) throw new Error('Catalog offline'); return catalogs(config.agent) },
    sendMessage: async (id: string) => { sent.push(id) }, interrupt: async () => {}, steer: async () => true,
  } as unknown as SessionManager
  const adapter = (kind: string) => ({ kind, label: kind, models: async () => catalogs(kind), resolveDefaults: async (config: AgentConfig) => ({ ...config,
    model: config.model || (kind === 'claude' ? 'alpha' : 'code'),
    ...(kind === 'codex' && config.agent === 'codex' && !config.reasoningEffort ? { reasoningEffort: 'medium' } : {}),
  }) })
  const registry = { adapter, all: () => ['claude', 'codex', 'opencode'].map(adapter) } as unknown as AgentRegistry
  const ctx = { db, config: { retention: { autoArchiveDays: 0, autoArchiveSchedule: '0 3 * * *' }, limits: { maxConcurrentSessions: 4 }, server: { port: 7317, publicUrl: 'https://example.test' }, paths: { database, memory: join(dir, 'memory'), worktrees: join(dir, 'worktrees') } } as Config }
  const app = Fastify({ logger: { level: 'error' } })
  app.addHook('onRequest', async (request) => {
    const supplied = bearerSecret(request.headers.authorization)
    const identity = supplied ? resolveApiToken(db, supplied) : null
    if (identity) { request.user = identity.user; request.apiToken = identity.token }
    else if (request.headers.cookie === 'test-owner') request.user = db.select().from(users).get()!
  })
  registerErrorHandler(app)
  const routes: string[] = []
  app.addHook('onRoute', (route) => { if (route.method === 'GET' || route.method === 'POST') routes.push(`${route.method} ${route.url}`) })
  const log = new EventLog(db)
  registerV1Routes(app, ctx, log, sessions, registry, { trackMessage() {}, taskStopped() {} } as unknown as WebhookService)
  registerApiTokenRoutes(app, ctx, registry)
  const requests = new AgentRequests(ctx, sessions, registry, undefined, Buffer.alloc(32, 1), undefined, undefined, log)
  requests.start(app.log)
  t.after(async () => { requests.stop(); await app.close(); sqlite.close(); await rm(dir, { recursive: true, force: true }) })
  const headers = { authorization: `Bearer ${secret}` }
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload })
  const initialize = async () => {
    const init = await post('/api/v1/mcp', { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
    assert.equal(init.statusCode, 200, init.body)
    return init.headers['mcp-session-id'] as string
  }
  const rpc = (session: string, method: string, params?: object) => app.inject({ method: 'POST', url: '/api/v1/mcp', headers: { ...headers, 'mcp-session-id': session }, payload: { jsonrpc: '2.0', id: Math.random(), method, params } })
  const call = async (session: string, name: string, args: object) => (await rpc(session, 'tools/call', { name, arguments: args })).json().result
  return { app, db, headers, token, post, initialize, rpc, call, sent, initial, routes, setOffline: () => { offline = true } }
}

test('policies distinguish unrestricted lists from empty lists and reject invalid budgets', () => {
  assert.equal(apiExecutionPolicySchema.safeParse(policy).success, true)
  for (const invalid of [ { agents: [] }, { agents: [{ ...policy.agents[0], models: [] }] }, { agents: [{ ...policy.agents[0], efforts: [] }] },
    { agents: [policy.agents[0], policy.agents[0]] }, { agents: [{ ...policy.agents[1], maxBudgetUsd: 1 }] } ]) {
    assert.equal(apiExecutionPolicySchema.safeParse(invalid).success, false)
  }
})

test('REST accepts another authorized model and CLI, applies budgets, and checks effective defaults', async (t) => {
  const h = await harness(t)
  const response = await h.post('/api/v1/projects/project/tasks', { prompt: 'Test', model: 'BETA', effort: 'low' })
  assert.equal(response.statusCode, 201, response.body)
  const launched = h.db.select().from(conversations).get()!
  assert.equal(JSON.parse(launched.config).model, 'beta')
  assert.equal(JSON.parse(launched.config).effort, 'low')
  assert.equal(JSON.parse(launched.config).maxBudgetUsd, 2)
  assert.equal((await h.post('/api/v1/projects/project/tasks', { prompt: 'Test', agent: 'codex', effort: 'max' })).statusCode, 201)
  for (const [body, code] of [
    [{ agent: 'grok' }, 'token_agent_denied'], [{ model: 'expensive' }, 'token_model_denied'], [{ effort: 'high' }, 'token_effort_denied'],
    [{ config: { maxBudgetUsd: 3 } }, 'token_budget_denied'], [{ config: { maxBudgetUsd: null } }, 'token_budget_denied'],
    [{ config: { permissionMode: 'bypassPermissions' } }, 'config_field_locked'], [{ agent: 'codex' }, 'token_effort_denied'],
  ] as const) {
    const denied = await h.post('/api/v1/projects/project/tasks', { prompt: 'Denied', ...body })
    assert.equal(denied.json().error.code, code, denied.body)
  }
  assert.equal(h.sent.length, 2)
  const discovered = (await h.app.inject({ url: '/api/v1/agents', headers: h.headers })).json()
  assert.deepEqual(discovered.agents.map((entry: { agent: string }) => entry.agent), ['claude', 'codex'])
  assert.deepEqual(discovered.agents[0].models.map((entry: { value: string }) => entry.value), ['alpha', 'beta'])
  assert.deepEqual(discovered.agents[0].models[0].efforts, ['low', 'medium'])
})

test('REST and MCP publish the same complete tool catalog and execute both families', async (t) => {
  const h = await harness(t)
  const session = await h.initialize()
  const rest = await h.app.inject({ url: '/api/v1/tools', headers: h.headers })
  assert.deepEqual(rest.json(), (await h.rpc(session, 'tools/list')).json().result)
  const names = rest.json().tools.map((tool: { name: string }) => tool.name)
  for (const name of ['start_session', 'list_models', 'read_memory', 'list_cards', 'create_task', 'reply_task', 'read_task_events', 'inspect_access']) assert.ok(names.includes(name), name)
  assert.equal(new Set(names).size, names.length)
  const read = await h.post('/api/v1/tools/list_projects', {})
  assert.match(read.json().content[0].text, /Project/)
  const task = await h.call(session, 'create_task', { projectId: 'project', prompt: 'Native via MCP', model: 'beta' })
  assert.equal(task.isError, undefined, JSON.stringify(task))
  const legacy = await h.call(session, 'start_session', { project: 'project', prompt: 'Legacy via MCP', model: 'beta', effort: 'low' })
  assert.equal(legacy.isError, undefined, JSON.stringify(legacy))
  const throughRest = await h.post('/api/v1/tools/start_session', { project: 'project', prompt: 'Legacy via REST', agent: 'codex', model: 'code', effort: 'high' })
  assert.equal(throughRest.json().isError, undefined, throughRest.body)
  for (const row of h.db.select().from(conversations).all()) assert.equal(row.createdByTokenId, h.token.id)
  const denied = await h.call(session, 'start_session', { project: 'project', prompt: 'Denied', model: 'expensive', __apiTokenId: 'spoofed' })
  assert.equal(denied.isError, true)
  assert.match(denied.content[0].text, /not allowed/)
  const listing = await h.call(session, 'list_models', { project: 'project' })
  assert.doesNotMatch(listing.content[0].text, /expensive|## opencode/)
  assert.equal(h.sent.length, 3)
})

test('scope-limited keys have identical transport access without gaining project tools', async (t) => {
  const h = await harness(t, { scopes: ['projects:read'] })
  const session = await h.initialize()
  const catalog = (await h.rpc(session, 'tools/list')).json().result
  assert.deepEqual(catalog, (await h.app.inject({ url: '/api/v1/tools', headers: h.headers })).json())
  assert.deepEqual(catalog.tools.map((tool: { name: string }) => tool.name), ['inspect_access', 'list_task_projects', 'list_agents'])
  assert.equal((await h.call(session, 'start_session', { project: 'project', prompt: 'Denied' })).isError, true)
  assert.equal((await h.call(session, 'create_task', { projectId: 'project', prompt: 'Denied' })).isError, true)
  assert.equal((await h.post('/api/v1/tools/write_memory', { project: 'project', file: 'bad.md', content: 'Denied' })).statusCode, 403)
  const notification = await h.app.inject({ method: 'POST', url: '/api/v1/mcp', headers: { ...h.headers, 'mcp-session-id': session }, payload: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'write_instructions', arguments: { project: 'project', content: 'Denied' } } } })
  assert.equal(notification.statusCode, 400)
  assert.equal(h.sent.length, 0)
})

test('editing a key affects connected clients and resumption; revocation still rejects the secret', async (t) => {
  const h = await harness(t)
  const session = await h.initialize()
  const task = await h.post('/api/v1/projects/project/tasks', { prompt: 'First', model: 'beta' })
  const id = task.json().id
  const updatedPolicy = { agents: [{ ...policy.agents[0], models: ['alpha'] }] }
  const updated = await h.app.inject({ method: 'PATCH', url: `/api/tokens/${h.token.id}`, headers: { cookie: 'test-owner' }, payload: { executionPolicy: updatedPolicy, agent: 'claude', config: h.initial } })
  assert.equal(updated.statusCode, 200, updated.body)
  const denied = await h.call(session, 'start_session', { project: 'project', prompt: 'Denied', model: 'beta' })
  assert.equal(denied.isError, true)
  assert.equal((await h.post(`/api/v1/tasks/${id}/messages`, { prompt: 'Resume' })).json().error.code, 'token_model_denied')
  assert.equal((await h.call(session, 'message_session', { project: 'project', session: id, body: 'Resume' })).isError, true)
  assert.equal((await h.call(session, 'interrupt_session', { project: 'project', session: id })).isError, undefined)
  assert.equal(h.sent.length, 1)
  h.db.update(apiTokens).set({ revokedAt: Date.now() }).where(eq(apiTokens.id, h.token.id)).run()
  assert.equal((await h.rpc(session, 'tools/list')).statusCode, 401)
  assert.equal((await h.app.inject({ url: '/api/v1/tools', headers: h.headers })).statusCode, 401)
})

test('legacy null policies preserve model freedom and configured budget caps cannot be raised', async (t) => {
  const h = await harness(t, { policy: null })
  assert.equal((await h.post('/api/v1/projects/project/tasks', { prompt: 'Legacy', model: 'expensive', effort: 'high' })).statusCode, 201)
  h.db.update(apiTokens).set({ config: JSON.stringify({ ...h.initial, maxBudgetUsd: 1, maxTurns: 5 }) }).where(eq(apiTokens.id, h.token.id)).run()
  for (const config of [{ maxBudgetUsd: 2 }, { maxBudgetUsd: null }, { maxTurns: 6 }, { maxTurns: null }]) {
    const response = await h.post('/api/v1/projects/project/tasks', { prompt: 'Denied', config })
    assert.equal(response.json().error.code, 'config_field_locked', response.body)
  }
  assert.equal((await h.post('/api/v1/projects/project/tasks', { prompt: 'Lower', config: { maxBudgetUsd: 0.5, maxTurns: 3 } })).statusCode, 201)
})


test('every public REST operation has a tool counterpart', async (t) => {
  const h = await harness(t)
  const normalize = (route: string) => route.replace(/:[A-Za-z]+/g, ':id')
  const exposed = new Set(TOOL_OPERATIONS.map((op) => normalize(`${op.method} ${op.route}`)))
  for (const route of h.routes) {
    if (!route.includes('/api/v1/') || /\/(mcp|tools)(?:$|\/)/.test(route)) continue
    // The project-specific list is the cross-project list with its projectId filter.
    if (route === 'GET /api/v1/projects/:id/tasks') continue
    assert.ok(exposed.has(normalize(route)), `Missing shared tool for ${route}`)
  }
})

test('deferred launches and catalog outages cannot bypass execution limits', async (t) => {
  const h = await harness(t)
  const session = await h.initialize()
  for (const [name, args] of [
    ['schedule_task', { name: 'Denied schedule', prompt: 'No', every_minutes: 30, model: 'expensive' }],
    ['create_automation', { name: 'Denied automation', prompt: 'No', model: 'expensive' }],
  ] as const) {
    const result = await h.call(session, name, { project: 'project', ...args })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /not allowed/)
  }
  assert.equal(h.db.select().from(scheduledTasks).all().length, 0)
  h.setOffline()
  const denied = await h.post('/api/v1/projects/project/tasks', { prompt: 'No', model: 'expensive' })
  assert.equal(denied.json().error.code, 'token_model_denied')
  assert.equal((await h.post('/api/v1/projects/project/tasks', { prompt: 'Allowed', model: 'beta' })).statusCode, 201)
})

test('REST tool calls do not evict connected MCP clients', async (t) => {
  const h = await harness(t)
  const sessions = []
  for (let i = 0; i < 4; i++) sessions.push(await h.initialize())
  for (let i = 0; i < 5; i++) assert.equal((await h.app.inject({ url: '/api/v1/tools', headers: h.headers })).statusCode, 200)
  for (const session of sessions) assert.equal((await h.rpc(session, 'ping')).statusCode, 200)
})
