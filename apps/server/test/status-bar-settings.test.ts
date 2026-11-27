import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { openDatabase, runMigrations, users } from '@sillage/db'
import { registerUserSettingsRoutes } from '../src/http/routes/user-settings.js'
import { registerErrorHandler } from '../src/http/errors.js'
import type { AppContext } from '../src/http/context.js'

test('the status line belongs to the account, and null brings back the default line', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-status-bar-'))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  for (const id of ['owner', 'other']) db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', isAdmin: id === 'other', createdAt: 0 }).run()
  const app = Fastify()
  registerErrorHandler(app)
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, String(request.headers['x-user']))).get()
  })
  registerUserSettingsRoutes(app, { db } as AppContext)
  t.after(async () => { await app.close(); sqlite.close(); await rm(dir, { recursive: true, force: true }) })

  const read = async (user: string) => (await app.inject({ url: '/api/me/settings', headers: { 'x-user': user } })).json()
  const write = (statusBar: unknown) => app.inject({ method: 'PATCH', url: '/api/me/settings', headers: { 'x-user': 'owner' }, payload: { statusBar } })
  assert.equal((await read('owner')).statusBar, null)

  // Keys stay free strings: one a later version adds or drops must not reject the whole list.
  const line = [{ key: 'quota', on: true, format: 'ring', windows: 'all' }, { key: 'tokens', on: false }, { key: 'from-the-future', on: true }]
  const saved = await write(line)
  assert.equal(saved.statusCode, 200, saved.body)
  assert.deepEqual((await read('owner')).statusBar, line)
  // Another account, administrator included, keeps the default line.
  assert.equal((await read('other')).statusBar, null)

  assert.equal((await write([{ key: 'quota', on: true, format: 'pie' }])).statusCode, 400)
  assert.equal((await write(null)).statusCode, 200)
  assert.equal((await read('owner')).statusBar, null)
})
