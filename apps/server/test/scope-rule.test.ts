import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { conversations, mcpServers, openDatabase, projects, runMigrations, users } from '@sillage/db'
import { DEFAULT_CLAUDE_CONFIG, type McpServer, type McpServerListDto } from '@sillage/protocol'
import { proposeMcpInstall } from '../src/agents/mcp-install.js'
import { projectOverview } from '../src/agents/overview.js'
import type { Config } from '../src/config.js'
import { EventLog } from '../src/events/event-log.js'
import type { AppContext } from '../src/http/context.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerInstructionRoutes } from '../src/http/routes/instructions.js'
import { registerMcpRoutes } from '../src/http/routes/mcp.js'
import { registerMemoryRoutes } from '../src/http/routes/memory.js'
import { registerSecretRoutes } from '../src/http/routes/secrets.js'
import { SecretStore } from '../src/secrets/store.js'
import type { SessionManager } from '../src/sessions/session-manager.js'

/**
 * The scope rule (`src/http/scope-access.ts`): what is global belongs to administrators, what is
 * in a project to its owner, and members of a shared project only read its configuration. Checked
 * here across entities and across both doors, the HTTP routes and the agent tools, with three
 * accounts so that no right hides behind another: an administrator who owns nothing, an owner who
 * is not an administrator, and a member who is neither.
 */
async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-scope-rule-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())

  for (const [id, isAdmin] of [['admin', true], ['owner', false], ['member', false]] as const) {
    db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', isAdmin, createdAt: 1 }).run()
  }
  db.insert(projects).values({ id: 'shared', name: 'shared', workspacePath: dir, ownerId: 'owner', visibility: 'shared', instructionsMode: 'sillage', memoryMode: 'sillage', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'private', name: 'private', workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  for (const userId of ['owner', 'member']) {
    db.insert(conversations).values({
      id: `c-${userId}`, projectId: 'shared', userId, agent: 'claude', title: userId, status: 'idle',
      config: JSON.stringify(DEFAULT_CLAUDE_CONFIG), createdAt: 1, updatedAt: 1,
    } as typeof conversations.$inferInsert).run()
  }

  const log = new EventLog(db)
  const secrets = new SecretStore(db, randomBytes(32))
  const sessions = { async sendMessage() {}, async reloadConfig() {} } as unknown as SessionManager
  const ctx = { db, config: { paths: { data: dir, memory: join(dir, 'memory') }, mcp: { sillageServer: true } } as unknown as Config } as AppContext

  const app = Fastify()
  // The account comes from a header: each call says who is asking.
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, String(request.headers['x-user']))).get()
  })
  registerErrorHandler(app)
  registerMcpRoutes(app, ctx, () => {}, { log, secrets, sessions })
  registerInstructionRoutes(app, ctx)
  registerMemoryRoutes(app, ctx)
  registerSecretRoutes(app, ctx, secrets)
  t.after(() => app.close())

  const call = async (user: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
    const response = await app.inject({ method, url, headers: { 'x-user': user }, ...(payload ? { payload } : {}) })
    const body = response.body ? (JSON.parse(response.body) as { error?: { code: string } }) : {}
    return { status: response.statusCode, code: body.error?.code ?? null, body: body as unknown }
  }
  const tool = (conversationId: string, name: string, args: object = {}) => {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
      env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: 'shared', SILLAGE_MCP_CONVERSATION: conversationId },
      encoding: 'utf8', timeout: 10000,
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
    })
    assert.equal(run.status, 0, run.stderr)
    return JSON.parse(run.stdout).result as { content: { text: string }[]; isError?: boolean }
  }
  return { db, dir, log, secrets, call, tool }
}

const stdio = { type: 'stdio', command: 'true', args: [], env: {} }

test('MCP servers: administrators write the global scope, owners their project, nobody else', async (t) => {
  const { call } = await harness(t)
  const create = (user: string, name: string, projectId: string | null) => call(user, 'POST', '/api/mcp/servers', { name, transport: stdio, projectId })

  // Global scope.
  assert.deepEqual([(await create('owner', 'g', null)).code, (await create('member', 'g', null)).code], ['admin_only', 'admin_only'])
  const global = await create('admin', 'g', null)
  assert.equal(global.status, 201)

  // Project scope: the owner, administrator or not; an administrator who owns nothing is a member.
  assert.equal((await create('member', 'p', 'shared')).code, 'project_edit_forbidden')
  assert.equal((await create('admin', 'p', 'shared')).code, 'project_edit_forbidden')
  // A project the caller cannot see is missing, not forbidden.
  assert.equal((await create('admin', 'p', 'private')).code, 'project_not_found')
  const scoped = await create('owner', 'p', 'shared')
  assert.equal(scoped.status, 201)
  const hidden = await create('owner', 'hidden', 'private')
  assert.equal(hidden.status, 201)

  const globalId = (global.body as McpServer).id
  const scopedId = (scoped.body as McpServer).id
  const hiddenId = (hidden.body as McpServer).id
  for (const user of ['member', 'admin']) {
    assert.equal((await call(user, 'PATCH', `/api/mcp/servers/${scopedId}`, { enabled: false })).code, 'project_edit_forbidden', user)
    assert.equal((await call(user, 'DELETE', `/api/mcp/servers/${scopedId}`)).code, 'project_edit_forbidden', user)
    assert.equal((await call(user, 'PATCH', `/api/mcp/servers/${hiddenId}`, { enabled: false })).code, 'mcp_server_not_found', user)
  }
  for (const user of ['owner', 'member']) {
    assert.equal((await call(user, 'PATCH', `/api/mcp/servers/${globalId}`, { enabled: false })).code, 'admin_only', user)
    assert.equal((await call(user, 'DELETE', `/api/mcp/servers/${globalId}`)).code, 'admin_only', user)
  }
  assert.equal((await call('owner', 'PATCH', `/api/mcp/servers/${scopedId}`, { name: 'renamed' })).status, 200)
  assert.equal((await call('admin', 'PATCH', `/api/mcp/servers/${globalId}`, { enabled: false })).status, 200)

  // Everyone reads what they can see: members the shared project's servers, never the private one.
  const names = async (user: string) => ((await call(user, 'GET', '/api/mcp/servers')).body as McpServerListDto).servers.map((server) => server.name).sort()
  assert.deepEqual(await names('member'), ['g', 'renamed'])
  assert.deepEqual(await names('owner'), ['g', 'hidden', 'renamed'])

  // Names: a global one is taken everywhere, a project one only where it is visible.
  assert.equal((await create('owner', 'g', 'shared')).code, 'mcp_server_name_taken')
  assert.equal((await create('admin', 'renamed', null)).code, 'mcp_server_name_taken')
  assert.equal((await create('owner', 'renamed', 'private')).status, 201)
  assert.equal((await call('owner', 'DELETE', `/api/mcp/servers/${scopedId}`)).status, 204)
})

test('an agent proposal is installed by whoever may write the chosen scope, and declined by anyone it was shown to', async (t) => {
  const { db, log, secrets, call } = await harness(t)
  const transport = { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer {{secret.TOKEN}}' } }
  const propose = (conversationId: string, name: string) =>
    proposeMcpInstall(db, log, { id: conversationId, projectId: 'shared' }, { name, transport }).event.requestId
  const answer = (user: string, conversationId: string, requestId: string, body: object) =>
    call(user, 'POST', `/api/conversations/${conversationId}/mcp-installs/${requestId}`, body)
  const install = (scope: 'project' | 'global', secretValues: object = { TOKEN: 'typed' }) => ({ decision: 'installed', name: 'svc', transport, scope, secrets: secretValues })

  // A member's session: the proposal is theirs to decline, not to install in either scope.
  const theirs = propose('c-member', 'svc')
  assert.equal((await answer('member', 'c-member', theirs, install('project'))).code, 'project_edit_forbidden')
  assert.equal((await answer('member', 'c-member', theirs, install('global'))).code, 'admin_only')
  // Nobody answers in another account's conversation, owner of the project included.
  assert.equal((await answer('owner', 'c-member', theirs, install('project'))).code, 'conversation_not_found')
  assert.equal(secrets.has('TOKEN'), false)
  assert.equal((await answer('member', 'c-member', theirs, { decision: 'declined' })).status, 200)

  // The owner's session: project scope with a typed secret, but neither the global scope nor a
  // stored secret's replacement, which stay with administrators.
  const mine = propose('c-owner', 'svc')
  assert.equal((await answer('owner', 'c-owner', mine, install('global'))).code, 'admin_only')
  secrets.put('TOKEN', 'stored')
  assert.equal((await answer('owner', 'c-owner', mine, install('project', { TOKEN: 'other' }))).code, 'mcp_install_secret_exists')
  assert.deepEqual((await call('owner', 'POST', '/api/secrets/check', { names: ['TOKEN', 'ABSENT'] })).body, { stored: ['TOKEN'] })
  assert.equal((await call('owner', 'GET', '/api/secrets')).code, 'admin_only')
  const installed = await answer('owner', 'c-owner', mine, install('project', {}))
  assert.equal(installed.status, 200)
  assert.equal(secrets.resolve('TOKEN'), 'stored')
  assert.equal(db.select().from(mcpServers).where(eq(mcpServers.name, 'svc')).get()?.projectId, 'shared')
})

test('instructions and memory follow the same rule through the interface', async (t) => {
  const { call } = await harness(t)
  assert.equal((await call('owner', 'PUT', '/api/instructions', { content: 'x' })).code, 'admin_only')
  assert.equal((await call('admin', 'PUT', '/api/instructions', { content: 'x' })).status, 200)
  for (const user of ['member', 'admin']) {
    assert.equal((await call(user, 'PATCH', '/api/projects/shared/instructions', { content: 'x' })).code, 'project_edit_forbidden', user)
    assert.equal((await call(user, 'PUT', '/api/projects/shared/memory/note.md', { content: 'x' })).code, 'project_edit_forbidden', user)
    // Reading stays open to everyone who sees the project.
    assert.equal((await call(user, 'GET', '/api/projects/shared/instructions')).status, 200, user)
  }
  assert.equal((await call('owner', 'PATCH', '/api/projects/shared/instructions', { content: 'x' })).status, 200)
  assert.equal((await call('owner', 'PUT', '/api/projects/shared/memory/note.md', { content: 'x' })).status, 204)
  assert.equal((await call('admin', 'PATCH', '/api/projects/private/instructions', { content: 'x' })).code, 'project_not_found')
})

test('agent tools answer like the interface for the account their session runs for', async (t) => {
  const { db, dir, tool } = await harness(t)
  const out = (result: { content: { text: string }[] }) => result.content[0]!.text

  // Project instructions: the owner's session writes, a member's is told who can.
  const refused = tool('c-member', 'edit_instructions', { old_text: '', new_text: '- Rule.' })
  assert.equal(refused.isError, true)
  assert.match(out(refused), /belongs to the project owner/)
  assert.equal(tool('c-owner', 'edit_instructions', { old_text: '', new_text: '- Rule.' }).isError, undefined)
  assert.match(out(tool('c-member', 'read_instructions')), /- Rule\./)
  assert.equal(tool('c-member', 'write_instructions', { content: 'Replaced.' }).isError, true)
  // Global instructions: neither is an administrator.
  assert.match(out(tool('c-owner', 'edit_instructions', { scope: 'global', old_text: '', new_text: 'x' })), /Only administrators/)

  // Project image: same owner, and a member's session is not even asked to set one.
  const logo = join(dir, 'logo.svg')
  await writeFile(logo, '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>')
  assert.match(projectOverview(db, { projectId: 'shared', conversationId: 'c-owner', sillageMcp: true }) ?? '', /set_project_image/)
  assert.doesNotMatch(projectOverview(db, { projectId: 'shared', conversationId: 'c-member', sillageMcp: true }) ?? '', /set_project_image/)
  const image = tool('c-member', 'set_project_image', { path: logo })
  assert.equal(image.isError, true)
  assert.match(out(image), /belongs to its owner/)
  assert.equal(tool('c-owner', 'set_project_image', { path: logo }).isError, undefined)
})
