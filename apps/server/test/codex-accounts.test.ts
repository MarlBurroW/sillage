import assert from 'node:assert/strict'
import { existsSync, symlinkSync, lstatSync, mkdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { openDatabase, runMigrations, users } from '@sillage/db'
import type { CodexAccount, CodexLoginStatusDto } from '@sillage/protocol'
import { CodexAccountHomes } from '../src/codex-accounts/homes.js'
import type { CodexLoginService } from '../src/codex-accounts/login.js'
import { CodexAccountStore } from '../src/codex-accounts/store.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerCodexAccountRoutes } from '../src/http/routes/codex-accounts.js'

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-codex-accounts-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  for (const id of ['owner', 'other']) {
    db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', createdAt: 1 }).run()
  }
  const store = new CodexAccountStore(db)
  const homes = new CodexAccountHomes(join(dir, 'codex-accounts'))

  // Login service without an app-server: records requests and simulates
  // the outcome chosen by this test.
  const calls: string[] = []
  let status: CodexLoginStatusDto = { state: 'idle', verificationUrl: null, userCode: null, error: null }
  const login = {
    status: () => status,
    startDeviceCode: async (id: string) => {
      calls.push(`device:${id}`)
      status = { state: 'pending', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234', error: null }
      return status
    },
    loginWithApiKey: async (id: string, apiKey: string) => {
      calls.push(`apikey:${id}:${apiKey}`)
      store.setIdentity(id, { authMode: 'apiKey', email: null, planType: null })
      status = { state: 'done', verificationUrl: null, userCode: null, error: null }
    },
    logout: async (id: string) => {
      calls.push(`logout:${id}`)
      store.setIdentity(id, { authMode: null, email: null, planType: null })
    },
    cancel: async (id: string) => { calls.push(`cancel:${id}`) },
    forget: async (id: string) => { calls.push(`forget:${id}`) },
  } as unknown as CodexLoginService

  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, String(request.headers['x-user'] ?? 'owner'))).get()
  })
  registerErrorHandler(app)
  registerCodexAccountRoutes(app, store, login)
  t.after(() => app.close())
  return { dir, store, homes, app, calls }
}

test('comptes Codex : par utilisateur, connexion par code ou clé, déconnexion', async (t) => {
  const { store, app, calls } = await harness(t)

  const created = await app.inject({ method: 'POST', url: '/api/codex-accounts', payload: { label: ' Boulot ' } })
  assert.equal(created.statusCode, 201, created.body)
  const account = created.json<CodexAccount>()
  assert.equal(account.label, 'Boulot')
  assert.equal(account.status, 'pending')
  assert.equal((await app.inject({ method: 'POST', url: '/api/codex-accounts', payload: { label: 'Boulot' } })).statusCode, 409)
  assert.equal((await app.inject({ url: `/api/codex-accounts/${account.id}/login`, headers: { 'x-user': 'other' } })).statusCode, 404)

  // Device codes: responses provide instructions, repeated by status.
  const device = await app.inject({ method: 'POST', url: `/api/codex-accounts/${account.id}/login`, payload: { type: 'deviceCode' } })
  assert.equal(device.statusCode, 200, device.body)
  assert.equal(device.json<CodexLoginStatusDto>().userCode, 'ABCD-1234')
  assert.equal((await app.inject(`/api/codex-accounts/${account.id}/login`)).json<CodexLoginStatusDto>().state, 'pending')
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/codex-accounts/${account.id}/login` })).statusCode, 204)
  assert.deepEqual(calls, [`device:${account.id}`, `cancel:${account.id}`])

  // API keys: ready by return, account becomes usable.
  calls.length = 0
  const keyed = await app.inject({ method: 'POST', url: `/api/codex-accounts/${account.id}/login`, payload: { type: 'apiKey', apiKey: 'sk-test' } })
  assert.equal(keyed.statusCode, 200, keyed.body)
  assert.equal(keyed.json<CodexLoginStatusDto>().state, 'done')
  const ready = store.find('owner', account.id)!
  assert.equal(ready.status, 'ready')
  assert.equal(ready.authMode, 'apiKey')
  assert.deepEqual(calls, [`apikey:${account.id}:sk-test`])
  assert.ok(!JSON.stringify((await app.inject('/api/codex-accounts')).json()).includes('sk-test'))

  // Ready-account logout, then owner-only rename and deletion.
  calls.length = 0
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/codex-accounts/${account.id}/login` })).statusCode, 204)
  assert.equal(store.find('owner', account.id)!.status, 'pending')
  assert.deepEqual(calls, [`logout:${account.id}`])
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/codex-accounts/${account.id}`, payload: { label: 'Travail' } })).statusCode, 204)
  assert.equal(store.list('owner')[0]?.label, 'Travail')
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/codex-accounts/${account.id}`, headers: { 'x-user': 'other' } })).statusCode, 404)
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/codex-accounts/${account.id}` })).statusCode, 204)
  assert.equal(store.list('owner').length, 0)
  assert.ok(calls.includes(`forget:${account.id}`))
})

test('home Codex d’un compte : tout est lié au home de l’utilisateur, sauf auth.json', async (t) => {
  const { dir, homes } = await harness(t)
  const userHome = join(dir, 'user-codex')
  mkdirSync(join(userHome, 'sessions'), { recursive: true })
  writeFileSync(join(userHome, 'config.toml'), 'model = "x"\n')
  writeFileSync(join(userHome, 'auth.json'), '{}')
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = userHome
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous })

  const home = homes.ensure('acct')
  assert.equal(readlinkSync(join(home, 'config.toml')), join(userHome, 'config.toml'))
  assert.equal(readlinkSync(join(home, 'sessions')), join(userHome, 'sessions'))
  assert.ok(!existsSync(join(home, 'auth.json')), 'La connexion de l’utilisateur ne passe pas au compte')
  assert.equal(homes.connected('acct'), false)

  // New user-home entries are linked later; Codex-created account-home entries
  // remain local.
  mkdirSync(join(userHome, 'memories'))
  writeFileSync(join(home, 'history.jsonl'), '')
  writeFileSync(join(userHome, 'history.jsonl'), 'user')
  homes.ensure('acct')
  assert.equal(readlinkSync(join(home, 'memories')), join(userHome, 'memories'))
  assert.ok(!lstatSync(join(home, 'history.jsonl')).isSymbolicLink())
  writeFileSync(join(home, 'auth.json'), '{}')
  assert.equal(homes.connected('acct'), true)

  // The models cache is keyed by auth identity: never shared, and a link left by an older
  // Sillage is removed so the account gets its own.
  writeFileSync(join(userHome, 'models_cache.json'), '{}')
  symlinkSync(join(userHome, 'models_cache.json'), join(home, 'models_cache.json'))
  homes.ensure('acct')
  assert.ok(!existsSync(join(home, 'models_cache.json')), 'Le cache des modèles reste propre au compte')
})
