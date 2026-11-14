import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import cookie from '@fastify/cookie'
import Fastify from 'fastify'
import { openDatabase, projects, runMigrations, users } from '@sillage/db'
import { createApiToken } from '../src/auth/api-tokens.js'
import { createSession } from '../src/auth/sessions.js'
import type { Config } from '../src/config.js'
import type { EventLog } from '../src/events/event-log.js'
import { registerErrorHandler, unauthorized } from '../src/http/errors.js'
import { registerIdentityHook } from '../src/http/identity.js'
import { registerLocalOriginGuard } from '../src/http/local-origin.js'
import { registerServerOriginGuard } from '../src/http/server-origin.js'
import type { Notifications } from '../src/notifications/dispatcher.js'
import type { SessionManager } from '../src/sessions/session-manager.js'
import { publicUrlOf, writeAppSettings } from '../src/settings/app-settings.js'
import type { TerminalManager } from '../src/terminals/terminal-manager.js'
import { registerWebSocketHub } from '../src/ws/hub.js'
import { registerTerminalHub } from '../src/ws/terminal-hub.js'

const PUBLIC_HOST = 'sillage.example.test'
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`
const FOREIGN_ORIGIN = 'https://demo.example.test'

async function harness(t: TestContext, profile: 'server' | 'desktop' = 'server') {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-browser-origin-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'Owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'Project', workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const { token } = await createSession(db, 'owner', 'origin test')
  const { secret } = createApiToken(db, {
    userId: 'owner', label: 'test', scopes: ['projects:read'], projectIds: [], agent: 'claude', config: {}, expiresAt: null, webhookUrl: null,
  })
  const config = { server: { publicUrl: '' }, paths: { data: dir } } as Config
  const ctx = { db, config }
  const sessions = {
    statusBus: new EventEmitter(), setNotifier: () => {}, warmConversationIds: () => [],
  } as unknown as SessionManager
  let attachments = 0
  const terminals = {
    attach: () => { attachments++; return { replay: '', cols: 80, rows: 24, exited: false, detach: () => {} } },
  } as unknown as TerminalManager

  const app = Fastify({ trustProxy: true })
  registerErrorHandler(app)
  if (profile === 'desktop') registerLocalOriginGuard(app, { allowed: () => ({ hostname: 'desk.tailnet.test', login: 'owner@example.test' }) })
  await app.register(cookie)
  registerIdentityHook(app, ctx)
  if (profile === 'server') registerServerOriginGuard(app, () => publicUrlOf(db, config))
  let writes = 0
  app.route({ method: ['POST', 'PUT', 'PATCH', 'DELETE'], url: '/api/state', handler: (request) => {
    if (!request.user) throw unauthorized()
    return { writes: ++writes }
  } })
  app.post('/api/auth/login', () => ({ reached: true }))
  app.post('/api/v1/example', (request) => {
    if (!request.apiToken) throw unauthorized()
    return { reached: true }
  })
  app.get('/api/health', () => ({ ok: true }))
  app.get('/api/benchmark-previews/run/index.html', () => 'preview')
  await registerWebSocketHub(app, ctx, {} as EventLog, sessions, { setPresence: () => {} } as unknown as Notifications)
  registerTerminalHub(app, ctx, terminals)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const { port } = app.server.address() as AddressInfo
  t.after(async () => {
    for (const socket of app.websocketServer.clients) socket.terminate()
    await app.close()
  })

  const localHost = `127.0.0.1:${port}`
  const localOrigin = `http://${localHost}`
  const authenticated = { cookie: `sillage_session=${token}` }
  const relayed = { host: PUBLIC_HOST, 'x-forwarded-proto': 'https', ...authenticated }
  const call = (path: string, headers: Record<string, string>, method = 'GET', upgrade = false) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method, agent: false, headers: {
        ...headers,
        ...(upgrade ? { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } : {}),
      } }, (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk.toString() })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode ?? 0, body: '' }) })
      req.on('error', (err) => reject(new Error(`${method} ${path} from ${headers.origin ?? '(no origin)'}: ${err.message}`)))
      req.setTimeout(3000, () => req.destroy(new Error('origin test request timed out')))
      req.end()
    })

  return { app, db, config, call, localHost, localOrigin, authenticated, relayed, secret, attachments: () => attachments, writes: () => writes }
}

test('Server refuses sibling-origin writes and both real WebSocket upgrades despite a valid cookie', async (t) => {
  const h = await harness(t)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const rejected = await h.call('/api/state', { ...h.relayed, origin: FOREIGN_ORIGIN }, method)
    assert.equal(rejected.status, 403, rejected.body)
    assert.equal(JSON.parse(rejected.body).error.code, 'forbidden_origin')
  }
  assert.equal(h.writes(), 0)
  for (const path of ['/api/ws', '/api/projects/project/terminal?terminalId=existing']) {
    for (const origin of [FOREIGN_ORIGIN, 'null', `${PUBLIC_ORIGIN}:8443`, 'http://sillage.example.test']) {
      const rejected = await h.call(path, { ...h.relayed, origin }, 'GET', true)
      assert.equal(rejected.status, 403, `${path}: ${rejected.body}`)
    }
    assert.equal((await h.call(path, { ...h.relayed, origin: PUBLIC_ORIGIN }, 'GET', true)).status, 101)
  }
  assert.equal(h.attachments(), 1, 'only the same-origin socket may attach the terminal')
  assert.equal((await h.call('/api/state', { ...h.relayed, origin: PUBLIC_ORIGIN }, 'POST')).status, 200)
  assert.equal(h.writes(), 1)
  // Login is unauthenticated but still must not be submitted by a sibling page.
  assert.equal((await h.call('/api/auth/login', { host: PUBLIC_HOST, 'x-forwarded-proto': 'https', origin: FOREIGN_ORIGIN }, 'POST')).status, 403)
})

test('Server pins configured hosts, follows settings changes, and retains local maintenance and proxies', async (t) => {
  const h = await harness(t)
  writeAppSettings(h.db, { publicUrl: PUBLIC_ORIGIN })
  assert.equal((await h.call('/api/health', { host: 'rebound.example.test' })).status, 403)
  assert.equal((await h.call('/api/state', { host: 'rebound.example.test', origin: 'http://rebound.example.test', ...h.authenticated }, 'POST')).status, 403)
  assert.equal((await h.call('/api/health', { host: PUBLIC_HOST })).status, 200)
  assert.equal((await h.call('/api/state', { ...h.relayed, origin: PUBLIC_ORIGIN }, 'POST')).status, 200)
  assert.equal((await h.call('/api/state', { ...h.relayed, origin: `http://${PUBLIC_HOST}` }, 'POST')).status, 403)
  assert.equal((await h.call('/api/state', { host: h.localHost, origin: h.localOrigin, ...h.authenticated }, 'POST')).status, 200)
  // A proxy may rewrite Host to its loopback backend when a public URL is explicit.
  assert.equal((await h.call('/api/state', { host: h.localHost, origin: PUBLIC_ORIGIN, ...h.authenticated }, 'POST')).status, 200)
  assert.equal((await h.call('/api/health', { host: h.localHost })).status, 200)
  assert.equal((await h.call('/api/health', { host: `${PUBLIC_HOST}@evil.example.test` })).status, 403)

  writeAppSettings(h.db, { publicUrl: 'https://renamed.example.test' })
  assert.equal((await h.call('/api/health', h.relayed)).status, 403)
  assert.equal((await h.call('/api/health', { host: 'renamed.example.test' })).status, 200)
  // An empty saved setting intentionally overrides the TOML default.
  h.config.server.publicUrl = PUBLIC_ORIGIN
  writeAppSettings(h.db, { publicUrl: '' })
  assert.equal((await h.call('/api/state', { host: 'dev.example.test:5317', origin: 'http://dev.example.test:5317', ...h.authenticated }, 'POST')).status, 200)
})

test('Server preserves token and non-browser callers without accepting forged bearer exemptions', async (t) => {
  const h = await harness(t)
  assert.equal((await h.call('/api/state', h.relayed, 'POST')).status, 200)
  assert.equal((await h.call('/api/ws', h.relayed, 'GET', true)).status, 101)
  for (const site of ['cross-site', 'same-site']) {
    assert.equal((await h.call('/api/state', { ...h.relayed, 'sec-fetch-site': site }, 'POST')).status, 403)
    assert.equal((await h.call('/api/ws', { ...h.relayed, 'sec-fetch-site': site }, 'GET', true)).status, 403)
  }
  const bearer = { host: PUBLIC_HOST, authorization: `Bearer ${h.secret}` }
  assert.equal((await h.call('/api/v1/example', bearer, 'POST')).status, 200)
  assert.equal((await h.call('/api/v1/example', { ...bearer, origin: FOREIGN_ORIGIN }, 'POST')).status, 200)
  assert.equal((await h.call('/api/v1/example', { ...h.relayed, authorization: 'Bearer invalid', origin: FOREIGN_ORIGIN }, 'POST')).status, 403)
  assert.equal((await h.call('/api/state', { ...h.relayed, authorization: `Bearer ${h.secret}`, origin: FOREIGN_ORIGIN }, 'POST')).status, 403)
  assert.equal((await h.call('/api/benchmark-previews/run/index.html', { host: PUBLIC_HOST, origin: 'null' })).status, 200)
})

test('Desktop retains local and tailnet origin enforcement for both WebSockets and benchmark reads', async (t) => {
  const h = await harness(t, 'desktop')
  const local = { host: h.localHost, ...h.authenticated }
  for (const path of ['/api/ws', '/api/projects/project/terminal?terminalId=existing']) {
    assert.equal((await h.call(path, { ...local, origin: 'http://127.0.0.1:5317' }, 'GET', true)).status, 403)
    assert.equal((await h.call(path, { ...local, origin: h.localOrigin }, 'GET', true)).status, 101)
  }
  assert.equal((await h.call('/api/health', { host: 'rebound.example.test' })).status, 403)
  assert.equal((await h.call('/api/state', { ...local, origin: FOREIGN_ORIGIN }, 'POST')).status, 403)
  assert.equal((await h.call('/api/benchmark-previews/run/index.html', { ...local, origin: 'null' })).status, 200)
  const tailnet = { host: 'desk.tailnet.test', origin: 'https://desk.tailnet.test', 'tailscale-user-login': 'owner@example.test', ...h.authenticated }
  assert.equal((await h.call('/api/ws', tailnet, 'GET', true)).status, 101)
  assert.equal((await h.call('/api/ws', { ...tailnet, origin: FOREIGN_ORIGIN }, 'GET', true)).status, 403)
  assert.equal((await h.call('/api/ws', { ...tailnet, 'tailscale-user-login': 'other@example.test' }, 'GET', true)).status, 403)
})
