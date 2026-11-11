import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import cookie from '@fastify/cookie'
import Fastify from 'fastify'
import { openDatabase, runMigrations, users } from '@sillage/db'
import type { TailscaleStatus } from '@sillage/protocol'
import type { Config } from '../src/config.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerIdentityHook } from '../src/http/identity.js'
import { registerLocalOriginGuard } from '../src/http/local-origin.js'
import { requireUser } from '../src/http/require-user.js'
import { registerRemoteAccessRoutes } from '../src/http/routes/remote-access.js'
import { RemoteAccessService } from '../src/remote-access/service.js'
import { parseServeConfig, parseStatus, type ServeMapping, type TailscaleCli } from '../src/remote-access/tailscale.js'
import { readRemoteAccess } from '../src/settings/app-settings.js'

const HOST = 'desk.tail1234.ts.net'
const LOGIN = 'owner@example.com'

/** Scripted CLI: tests set what Tailscale reports and read what Sillage asked of Serve. */
class FakeTailscale implements TailscaleCli {
  statusValue: TailscaleStatus = { state: 'running', hostname: HOST, login: LOGIN, https: true }
  mapping: ServeMapping | null = null
  refuse: string | null = null
  calls: string[] = []
  async status() { return this.statusValue }
  async serveStatus() { return this.mapping }
  async serve(httpsPort: number, target: number) {
    this.calls.push(`serve ${httpsPort} ${target}`)
    if (this.refuse) throw new Error(this.refuse)
    this.mapping = { target, funnel: false }
  }
  async serveOff(httpsPort: number) {
    this.calls.push(`off ${httpsPort}`)
    this.mapping = null
  }
}

async function database(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-remote-access-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'local', username: 'local', displayName: 'me', passwordHash: '', isAdmin: true, createdAt: 1 }).run()
  return db
}

/** A listening desktop-like app: the guard reads the socket's port, which injection does not provide. */
async function desktopApp(t: TestContext) {
  const db = await database(t)
  const cli = new FakeTailscale()
  const app = Fastify({ trustProxy: true })
  registerErrorHandler(app)
  const service = new RemoteAccessService(db, cli, app.log)
  registerLocalOriginGuard(app, service)
  await app.register(cookie)
  registerIdentityHook(app, { db, config: {} as Config })
  app.get('/api/me', async (request) => ({ id: requireUser(request).id }))
  registerRemoteAccessRoutes(app, service)
  await app.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => app.close())
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await service.listening(port)

  const call = (path: string, headers: Record<string, string>, method = 'GET') =>
    new Promise<{ status: number; body: string; cookie: string | undefined }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk.toString() })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, cookie: res.headers['set-cookie']?.[0] }))
      })
      req.on('error', reject)
      req.end()
    })
  const local = { host: `127.0.0.1:${port}` }
  const relayed = { host: HOST, 'tailscale-user-login': LOGIN, 'x-forwarded-proto': 'https' }
  return { db, cli, service, port, call, local, relayed }
}

test('Tailscale status and Serve config are read down to what remote access decides on', () => {
  const running = parseStatus(JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: `${HOST}.`, UserID: 42, Tags: null },
    User: { '42': { LoginName: LOGIN } },
    CertDomains: [HOST],
  }))
  assert.deepEqual(running, { state: 'running', hostname: HOST, login: LOGIN, https: true })
  assert.deepEqual(parseStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: '' } })), { state: 'stopped', backend: 'NeedsLogin' })
  const tagged = parseStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.`, UserID: 1, Tags: ['tag:server'] }, User: { '1': { LoginName: 'tagged-devices' } }, CertDomains: [] }))
  assert.deepEqual(tagged, { state: 'running', hostname: HOST, login: null, https: false })
  assert.equal(parseStatus('not json').state, 'error')

  const config = JSON.stringify({
    TCP: { '443': { HTTPS: true }, '7476': { HTTP: true } },
    Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:52533' } } }, [`${HOST}:7476`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7476' } } } },
    AllowFunnel: { [`${HOST}:443`]: true },
  })
  assert.deepEqual(parseServeConfig(config, 443), { target: 52533, funnel: true })
  assert.equal(parseServeConfig(config, 8443), null)
  assert.equal(parseServeConfig('', 443), null)
  assert.deepEqual(parseServeConfig(JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { '/': { Text: 'hi' } } } } }), 443), { target: null, funnel: false })
})

test('A desktop instance stays local until remote access is enabled, then signs the owner in', async (t) => {
  const { db, cli, call, local, relayed, port } = await desktopApp(t)

  // Off: the tailnet hostname is refused like any foreign host, even with the identity header.
  assert.equal((await call('/api/me', local)).status, 401)
  assert.equal((await call('/api/me', relayed)).status, 403)
  assert.match((await call('/api/me', relayed)).body, /forbidden_host/)

  // The route itself needs the local window's session: enable through the service as the page would.
  const { token } = await import('../src/auth/sessions.js').then((m) => m.createSession(db, 'local', 'test'))
  const window = { ...local, cookie: `sillage_session=${token}` }
  const enabled = await call('/api/remote-access/enable', window, 'POST')
  assert.equal(enabled.status, 200)
  const state = JSON.parse(enabled.body)
  assert.equal(state.enabled, true)
  assert.equal(state.url, `https://${HOST}`)
  assert.equal(state.login, LOGIN)
  assert.deepEqual(cli.calls, [`serve 443 ${port}`])
  assert.deepEqual(readRemoteAccess(db), { enabled: true, hostname: HOST, login: LOGIN })

  // Relayed by Serve for the owner: a session opens by itself, with a secure cookie.
  const first = await call('/api/me', relayed)
  assert.equal(first.status, 200)
  assert.equal(JSON.parse(first.body).id, 'local')
  assert.match(first.cookie ?? '', /^sillage_session=.+Secure/)
  // Browsers also send the Host with a port when Serve listens elsewhere than 443.
  assert.equal((await call('/api/me', { ...relayed, host: `${HOST}:8443`, origin: `https://${HOST}:8443` })).status, 200)
  // The cookie works on its own afterwards.
  const session = (first.cookie ?? '').split(';')[0]
  assert.equal((await call('/api/me', { ...relayed, cookie: session })).status, 200)

  // Someone else on the tailnet, a Funnel visitor (no identity header) and a foreign origin are refused.
  assert.match((await call('/api/me', { ...relayed, 'tailscale-user-login': 'intruder@example.com' })).body, /forbidden_identity/)
  assert.match((await call('/api/me', { host: HOST })).body, /forbidden_identity/)
  assert.match((await call('/api/me', { ...relayed, origin: 'https://evil.example' })).body, /forbidden_origin/)
  // A header forged on a local request means nothing: the local host keeps its own checks.
  assert.equal((await call('/api/me', { ...local, 'tailscale-user-login': LOGIN })).status, 401)

  // Off again: the mapping Sillage made is removed and the hostname is foreign once more.
  const disabled = await call('/api/remote-access/disable', window, 'POST')
  assert.equal(JSON.parse(disabled.body).enabled, false)
  assert.deepEqual(cli.calls.at(-1), 'off 443')
  assert.match((await call('/api/me', relayed)).body, /forbidden_host/)
})

test('Serve refusals leave access enabled with the command to run, and restarts follow the port', async (t) => {
  const { cli, service, port } = await desktopApp(t)
  cli.refuse = 'Access denied: serve config denied'
  const state = await service.enable()
  assert.equal(state.enabled, true)
  assert.equal(state.serveError, cli.refuse)
  assert.deepEqual(state.serve, { target: null, funnel: false })

  // The user ran the command by hand, then the launcher came back on another port.
  cli.refuse = null
  cli.mapping = { target: port, funnel: false }
  await service.listening(port + 1)
  assert.deepEqual(cli.calls.at(-1), `serve 443 ${port + 1}`)
  assert.equal((await service.state()).serveError, null)

  // Another program's mapping on 443 is not ours to remove.
  cli.mapping = { target: 9999, funnel: false }
  await service.disable()
  assert.ok(!cli.calls.includes('off 443'))

  // Enabling needs a connected client, an account and HTTPS on the tailnet.
  cli.statusValue = { state: 'running', hostname: HOST, login: LOGIN, https: false }
  await assert.rejects(service.enable(), /tailnet/)
  cli.statusValue = { state: 'stopped', backend: 'NeedsLogin' }
  await assert.rejects(service.enable(), /not connected/)
  assert.equal(service.allowed(), null)
})
