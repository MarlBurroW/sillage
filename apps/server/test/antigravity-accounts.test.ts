import assert from 'node:assert/strict'
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { openDatabase, runMigrations, users } from '@sillage/db'
import { AntigravityAccountHomes } from '../src/antigravity-accounts/homes.js'
import { AntigravityAccountStore } from '../src/antigravity-accounts/store.js'
import { AntigravityLoginService } from '../src/antigravity-accounts/login.js'
import { registerAntigravityAccountRoutes } from '../src/http/routes/antigravity-accounts.js'
import { registerErrorHandler } from '../src/http/errors.js'

test('Google account routes enforce ownership, relay OAuth and redact failed API-key authentication', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sillage-google-account-routes-'))
  const binary = join(root, 'agent.mjs')
  await copyFile(new URL('./fixtures/antigravity-agent.mjs', import.meta.url), binary)
  await chmod(binary, 0o700)
  const { db, sqlite } = openDatabase(join(root, 'test.db'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  for (const id of ['owner', 'other']) db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', createdAt: 1 }).run()
  const store = new AntigravityAccountStore(db)
  const homes = new AntigravityAccountHomes(join(root, 'accounts'), (id) => store.ownerOf(id))
  const login = new AntigravityLoginService(homes, store, async () => binary)
  const app = Fastify()
  app.addHook('preHandler', async (request) => { request.user = db.select().from(users).where(eq(users.id, String(request.headers['x-user'] ?? 'owner'))).get() })
  registerErrorHandler(app)
  registerAntigravityAccountRoutes(app, store, login)
  t.after(async () => { await login.closeAll(); await app.close(); sqlite.close(); await rm(root, { recursive: true, force: true }) })
  const wait = async (check: () => boolean) => {
    const until = Date.now() + 5000
    while (!check()) { if (Date.now() > until) throw new Error('Authentication fixture timed out'); await new Promise((resolve) => setTimeout(resolve, 10)) }
  }
  const create = await app.inject({ method: 'POST', url: '/api/antigravity-accounts', payload: { label: 'Personal' } })
  assert.equal(create.statusCode, 201)
  const id = create.json().id as string
  const base = `/api/antigravity-accounts/${id}`
  assert.equal((await app.inject({ method: 'POST', url: '/api/antigravity-accounts', payload: { label: 'Personal' } })).statusCode, 409)
  for (const [method, url, payload] of [['GET', base + '/login'], ['POST', base + '/callback', { url: 'http://127.0.0.1:1234/?code=a' }], ['DELETE', base]] as const) {
    assert.equal((await app.inject({ method, url, headers: { 'x-user': 'other' }, ...(payload ? { payload } : {}) })).statusCode, 404)
  }
  assert.equal((await app.inject({ method: 'POST', url: base + '/login', payload: { method: 'oauth-personal' } })).json().state, 'pending')
  await wait(() => Boolean(login.status(id).verificationUrl))
  const auth = new URL(login.status(id).verificationUrl!)
  const callback = new URL(auth.searchParams.get('redirect_uri')!)
  callback.searchParams.set('state', auth.searchParams.get('state')!)
  callback.searchParams.set('code', 'fixture-authorization-code')
  assert.equal((await app.inject({ method: 'POST', url: base + '/callback', payload: { url: callback.href } })).statusCode, 204)
  await wait(() => login.status(id).state === 'done')
  assert.equal(store.find('owner', id)?.plan, 'Google AI Pro')
  assert.equal(store.find('owner', id)?.status, 'ready')
  assert.equal((await app.inject({ method: 'DELETE', url: base + '/login' })).statusCode, 204)
  await assert.rejects(readFile(join(homes.path(id), 'antigravity-acp', 'acp_token.json')))
  await writeFile(join(root, 'reject-login'), '')
  await app.inject({ method: 'POST', url: base + '/login', payload: { method: 'gemini-api-key', apiKey: 'never-return-this-key' } })
  await wait(() => login.status(id).state === 'failed')
  assert.equal(store.find('owner', id)?.status, 'pending')
  assert.ok(!(await app.inject(base + '/login')).body.includes('never-return-this-key'))
  assert.ok(!(await app.inject('/api/antigravity-accounts')).body.includes('never-return-this-key'))
  assert.equal((await app.inject({ method: 'DELETE', url: base })).statusCode, 204)
  assert.equal(store.list('owner').length, 0)
})
