import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { openDatabase, runMigrations, users } from '@sillage/db'
import type { CopilotAccount, CopilotLoginStatusDto } from '@sillage/protocol'
import { CopilotCatalog } from '../src/agents/copilot/catalog.js'
import { copilotProcessEnv } from '../src/agents/copilot/launch.js'
import { CopilotAccountHomes, copilotIdentity } from '../src/copilot-accounts/homes.js'
import { CopilotLoginService } from '../src/copilot-accounts/login.js'
import { CopilotAccountStore } from '../src/copilot-accounts/store.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerCopilotAccountRoutes } from '../src/http/routes/copilot-accounts.js'

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-copilot-accounts-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  for (const id of ['owner', 'other']) {
    db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', createdAt: 1 }).run()
  }
  // The machine's own home, signed in, which account homes link into.
  const userHome = join(dir, 'user-copilot')
  mkdirSync(join(userHome, 'skills'), { recursive: true })
  writeFileSync(join(userHome, 'session-store.db'), '')
  writeFileSync(join(userHome, 'mcp-config.json'), '{"mcpServers":{}}')
  writeFileSync(join(userHome, 'settings.json'), '{"model":"auto","storeTokenPlaintext":false}')
  writeFileSync(join(userHome, 'config.json'), JSON.stringify({ lastLoggedInUser: { host: 'https://github.com', login: 'machine' } }))
  const previous = process.env.COPILOT_HOME
  process.env.COPILOT_HOME = userHome
  t.after(() => { if (previous === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = previous })

  const binary = join(dir, 'copilot.mjs')
  copyFileSync(new URL('./fixtures/copilot-agent.mjs', import.meta.url), binary)
  chmodSync(binary, 0o700)
  const store = new CopilotAccountStore(db)
  const homes = new CopilotAccountHomes(join(dir, 'copilot-accounts'))
  const login = new CopilotLoginService(homes, store, async () => binary)
  t.after(() => login.closeAll())
  return { dir, db, userHome, binary, store, homes, login }
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('Copilot account home links the user home except the sign-in, settings and logs', async (t) => {
  const { userHome, homes } = await harness(t)
  const home = homes.ensure('acct')
  assert.equal(readlinkSync(join(home, 'session-store.db')), join(userHome, 'session-store.db'))
  assert.equal(readlinkSync(join(home, 'session-state')), join(userHome, 'session-state'), 'sessions resume from any account')
  assert.equal(readlinkSync(join(home, 'skills')), join(userHome, 'skills'))
  assert.ok(!existsSync(join(home, 'config.json')), "the machine's sign-in does not pass to the account")
  assert.equal(homes.connected('acct'), false)
  // The user's settings, with consent to store the token without a keychain.
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')), { model: 'auto', storeTokenPlaintext: true })

  mkdirSync(join(userHome, 'agents'))
  mkdirSync(join(home, 'logs'))
  homes.ensure('acct')
  assert.equal(readlinkSync(join(home, 'agents')), join(userHome, 'agents'), 'entries the user adds later reach the account')
  assert.ok(!lstatSync(join(home, 'logs')).isSymbolicLink())
})

test('Copilot identity is read from config.json, comment lines included', async (t) => {
  const { dir } = await harness(t)
  const home = join(dir, 'identity')
  mkdirSync(home)
  assert.equal(copilotIdentity(home), null)
  writeFileSync(join(home, 'config.json'), '// managed automatically\n{"loggedInUsers":[{"host":"https://example.ghe.com","login":"enterprise"}]}')
  assert.deepEqual(copilotIdentity(home), { login: 'enterprise', host: 'https://example.ghe.com' })
  writeFileSync(join(home, 'config.json'), '{"firstLaunchAt":"2026-11-27T14:46:08.000Z"}')
  assert.equal(copilotIdentity(home), null, 'a home Copilot only launched in is not signed in')
})

test('Copilot device-code sign-in reads the URL and code, then keeps the GitHub login', async (t) => {
  const { store, homes, login } = await harness(t)
  const account = store.create('owner', 'Work')
  const started = await login.startDeviceCode(account.id)
  assert.deepEqual(started, { state: 'pending', verificationUrl: 'https://github.com/login/device', userCode: 'B2E9-F9F7', error: null })
  await until(() => login.status(account.id).state === 'done', 'sign-in')
  const ready = store.find('owner', account.id)!
  assert.equal(ready.status, 'ready')
  assert.equal(ready.login, 'octo-fixture')
  assert.equal(ready.host, 'https://github.com')
  assert.ok(homes.connected(account.id))

  await login.logout(account.id)
  assert.equal(homes.connected(account.id), false)
  assert.equal(store.find('owner', account.id)!.status, 'pending')
})

test('Copilot sign-in refused keeps the reason Copilot printed', async (t) => {
  const { store, login } = await harness(t)
  const account = store.create('owner', 'Refused')
  process.env.FIXTURE_LOGIN = 'fail'
  t.after(() => { delete process.env.FIXTURE_LOGIN })
  await login.startDeviceCode(account.id)
  await until(() => login.status(account.id).state === 'failed', 'failure')
  assert.match(login.status(account.id).error ?? '', /access_denied/)
  assert.doesNotMatch(login.status(account.id).error ?? '', /Failed to open browser/)
  assert.equal(store.find('owner', account.id)!.status, 'pending')
})

test("Copilot processes on an account's home lose the server's tokens", () => {
  const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN }
  process.env.GH_TOKEN = 'gh-cli-token'
  process.env.GITHUB_TOKEN = 'env-token'
  try {
    const account = copilotProcessEnv({ COPILOT_HOME: '/accounts/a' })
    assert.equal(account.GH_TOKEN, undefined)
    assert.equal(account.GITHUB_TOKEN, undefined)
    assert.equal(account.COPILOT_HOME, '/accounts/a')
    // The machine's sign-in keeps them: they are how a server without `copilot login` signs in.
    assert.equal(copilotProcessEnv({}).GH_TOKEN, 'gh-cli-token')
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  }
})

test("Copilot catalog probes inside the account's home, one cache entry per home", async (t) => {
  const { dir, binary, homes } = await harness(t)
  const catalog = new CopilotCatalog(async () => binary, join(dir, 'catalog'))
  const launched = () => JSON.parse(readFileSync(join(dir, 'launch.json'), 'utf8')) as { home: string | null }
  const home = homes.ensure('acct')
  await catalog.list(false, home)
  assert.equal(launched().home, home)
  await catalog.list(false)
  assert.equal(launched().home, process.env.COPILOT_HOME, 'the machine sign-in probes under its own home')
})

test('Copilot account routes: per user, unique labels, sign-in and sign-out', async (t) => {
  const { db, store, login } = await harness(t)
  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, String(request.headers['x-user'] ?? 'owner'))).get()
  })
  registerErrorHandler(app)
  registerCopilotAccountRoutes(app, store, login)

  const created = await app.inject({ method: 'POST', url: '/api/copilot-accounts', payload: { label: ' Work ' } })
  assert.equal(created.statusCode, 201)
  const account = created.json<CopilotAccount>()
  assert.equal(account.label, 'Work')
  assert.equal((await app.inject({ method: 'POST', url: '/api/copilot-accounts', payload: { label: 'Work' } })).statusCode, 409)
  assert.equal((await app.inject({ url: `/api/copilot-accounts/${account.id}/login`, headers: { 'x-user': 'other' } })).statusCode, 404)
  assert.deepEqual((await app.inject({ url: '/api/copilot-accounts', headers: { 'x-user': 'other' } })).json(), { accounts: [] })

  const started = await app.inject({ method: 'POST', url: `/api/copilot-accounts/${account.id}/login` })
  assert.equal(started.json<CopilotLoginStatusDto>().userCode, 'B2E9-F9F7')
  await until(() => login.status(account.id).state === 'done', 'sign-in')
  assert.equal((await app.inject('/api/copilot-accounts')).json<{ accounts: CopilotAccount[] }>().accounts[0]?.login, 'octo-fixture')

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/copilot-accounts/${account.id}/login` })).statusCode, 204)
  assert.equal((await app.inject('/api/copilot-accounts')).json<{ accounts: CopilotAccount[] }>().accounts[0]?.status, 'pending')
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/copilot-accounts/${account.id}`, payload: { label: 'Personal' } })).statusCode, 204)
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/copilot-accounts/${account.id}`, headers: { 'x-user': 'other' } })).statusCode, 404)
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/copilot-accounts/${account.id}` })).statusCode, 204)
  assert.deepEqual((await app.inject('/api/copilot-accounts')).json(), { accounts: [] })
})
