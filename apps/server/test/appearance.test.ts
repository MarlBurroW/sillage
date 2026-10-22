import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { openDatabase, runMigrations, users } from '@sillage/db'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerUserSettingsRoutes } from '../src/http/routes/user-settings.js'
import type { AppContext } from '../src/http/context.js'

test('apparence : le style d’activité traverse l’API et la base, les anciens réglages restent lisibles', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-appearance-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  const user = {
    id: 'appearance-user', username: 'appearance', displayName: 'Appearance',
    passwordHash: 'unused', createdAt: Date.now(), isAdmin: false,
  }
  db.insert(users).values(user).run()
  const app = Fastify()
  app.addHook('preHandler', async (request) => { request.user = user })
  registerErrorHandler(app)
  registerUserSettingsRoutes(app, { db } as AppContext)
  t.after(() => app.close())

  const appearance = { theme: 'dark', syntax: 'ocean', values: { hue: 250, readingSize: 1 } }
  const saved = await app.inject({
    method: 'PATCH', url: '/api/me/settings',
    payload: { appearance: { ...appearance, typingIndicator: 'constellation' } },
  })
  assert.equal(saved.statusCode, 200, saved.body)
  assert.deepEqual((await app.inject('/api/me/settings')).json().appearance, {
    ...appearance, typingIndicator: 'constellation',
  })

  // Older interfaces omit this choice without losing their colors.
  const legacy = await app.inject({ method: 'PATCH', url: '/api/me/settings', payload: { appearance } })
  assert.equal(legacy.statusCode, 200, legacy.body)
  assert.deepEqual((await app.inject('/api/me/settings')).json().appearance, appearance)

  const invalid = await app.inject({
    method: 'PATCH', url: '/api/me/settings',
    payload: { appearance: { ...appearance, typingIndicator: 'x'.repeat(41) } },
  })
  assert.equal(invalid.statusCode, 400)
  assert.deepEqual((await app.inject('/api/me/settings')).json().appearance, appearance)
})
