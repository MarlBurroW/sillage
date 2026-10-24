import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { cards, openDatabase, projects, runMigrations, users } from '@sillage/db'
import type { ApiScope } from '@sillage/protocol'
import { bearerSecret, createApiToken, resolveApiToken } from '../src/auth/api-tokens.js'
import type { Config } from '../src/config.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerMcpRoutes } from '../src/http/v1/mcp.js'

/** MCP HTTP bridge: one real server process per API-token-protected session. Tools themselves are covered by `mcp-global.test.ts`. */

async function harness(t: TestContext, scopes: ApiScope[] = ['mcp'], projectIds: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-mcp-http-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'Owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(users).values({ id: 'other', username: 'other', displayName: 'Other', passwordHash: '', createdAt: 2 }).run()
  for (const [id, ownerId, visibility] of [['mine', 'owner', 'private'], ['shared', 'other', 'shared'], ['theirs', 'other', 'private']] as const) {
    db.insert(projects).values({ id, name: id, workspacePath: join(dir, id), ownerId, visibility, createdAt: 1 }).run()
  }
  const { secret } = createApiToken(db, {
    userId: 'owner', label: 'mcp', scopes, projectIds, agent: 'claude', config: {}, expiresAt: null, webhookUrl: null,
  })

  const app = Fastify()
  app.addHook('onRequest', async (request) => {
    const given = bearerSecret(request.headers.authorization)
    const identity = given ? resolveApiToken(db, given) : null
    if (identity) { request.user = identity.user; request.apiToken = identity.token }
  })
  registerErrorHandler(app)
  const config = { paths: { database: dbPath, memory: join(dir, 'memory') } } as unknown as Config
  registerMcpRoutes(app, { db, config })
  t.after(() => app.close())

  let counter = 0
  const post = (message: object, session?: string, auth = `Bearer ${secret}`) =>
    app.inject({
      method: 'POST', url: '/api/v1/mcp',
      headers: { authorization: auth, ...(session ? { 'mcp-session-id': session } : {}) },
      payload: message,
    })
  const call = async (session: string, name: string, args: object) => {
    const response = await post({ jsonrpc: '2.0', id: ++counter, method: 'tools/call', params: { name, arguments: args } }, session)
    assert.equal(response.statusCode, 200, response.body)
    return response.json().result as { content: { text: string }[]; isError?: boolean }
  }
  const initialize = async () => {
    const response = await post({ jsonrpc: '2.0', id: ++counter, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    assert.equal(response.statusCode, 200, response.body)
    return response.headers['mcp-session-id'] as string
  }
  const remove = (session: string, auth = `Bearer ${secret}`) =>
    app.inject({ method: 'DELETE', url: '/api/v1/mcp', headers: { authorization: auth, 'mcp-session-id': session } })
  return { db, dir, app, post, call, initialize, remove }
}

test('MCP HTTP : initialize ouvre une session au nom du compte, bornée à ce qu il voit', async (t) => {
  const h = await harness(t)
  const session = await h.initialize()
  assert.ok(session)

  const listing = await h.post({ jsonrpc: '2.0', id: 'list', method: 'tools/list' }, session)
  const names = (listing.json().result.tools as { name: string }[]).map((tool) => tool.name)
  assert.equal(names[0], 'list_projects')
  assert.ok(!names.includes('send_session_message'))

  const projects = (await h.call(session, 'list_projects', {})).content[0]!.text
  assert.match(projects, /mine \(id mine\)/)
  assert.match(projects, /shared \(id shared\)/)
  assert.doesNotMatch(projects, /theirs/)
  assert.equal((await h.call(session, 'list_cards', { project: 'theirs' })).isError, true)

  // Notifications expect no responses.
  const notified = await h.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session)
  assert.equal(notified.statusCode, 202)

  const created = await h.call(session, 'write_instructions', { project: 'mine', content: '# Mine' })
  assert.equal(created.isError, undefined, created.content[0]?.text)
  assert.match((await h.call(session, 'read_instructions', { project: 'mine' })).content[0]!.text, /# Mine/)

})

test('MCP HTTP : la liste blanche du jeton restreint les projets', async (t) => {
  const h = await harness(t, ['mcp'], ['shared'])
  const session = await h.initialize()
  const projects = (await h.call(session, 'list_projects', {})).content[0]!.text
  assert.match(projects, /1 project/)
  assert.match(projects, /shared/)
  assert.equal((await h.call(session, 'list_cards', { project: 'mine' })).isError, true)
})

test('MCP HTTP : portée, session et corps sont exigés', async (t) => {
  const h = await harness(t, ['projects:read'])
  const refused = await h.post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal(refused.statusCode, 403)

  const scoped = await harness(t)
  assert.equal((await scoped.post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode, 404)
  assert.equal((await scoped.post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'nope')).statusCode, 404)
  assert.equal((await scoped.post([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).statusCode, 400)
  assert.equal((await scoped.post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, undefined, 'Bearer wrong')).statusCode, 401)

  const session = await scoped.initialize()
  const other = await harness(t)
  // Sessions accept only tokens that opened them.
  assert.equal((await other.post({ jsonrpc: '2.0', id: 1, method: 'ping' }, session)).statusCode, 404)
  assert.equal((await scoped.remove(session, 'Bearer wrong')).statusCode, 401)
})

test('MCP HTTP : fermer la session, puis elle n existe plus', async (t) => {
  const h = await harness(t)
  const session = await h.initialize()
  assert.equal((await h.post({ jsonrpc: '2.0', id: 1, method: 'ping' }, session)).statusCode, 200)
  assert.equal((await h.remove(session)).statusCode, 204)
  assert.equal((await h.post({ jsonrpc: '2.0', id: 2, method: 'ping' }, session)).statusCode, 404)
})
