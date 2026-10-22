import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { openDatabase, runMigrations, users } from '@sillage/db'
import { eq } from 'drizzle-orm'
import { registerUserSettingsRoutes } from '../src/http/routes/user-settings.js'
import { registerErrorHandler } from '../src/http/errors.js'
import type { AppContext } from '../src/http/context.js'

test('le style des outils persiste sur le compte sans modifier les autres réglages', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-tool-appearance-'))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  const now = Date.now()
  for (const id of ['server-account', 'desktop-account']) db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', isAdmin: true, createdAt: now }).run()
  const app = Fastify()
  registerErrorHandler(app)
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, String(request.headers['x-user']))).get()
  })
  registerUserSettingsRoutes(app, { db } as AppContext)
  t.after(async () => { await app.close(); sqlite.close(); await rm(dir, { recursive: true, force: true }) })
  for (const id of ['server-account', 'desktop-account']) {
    for (const toolStyle of ['inline', 'timeline', 'intent', 'cards', 'console', 'classic']) {
      const appearance = { theme: 'dark', syntax: 'sillage', typingIndicator: 'wave', toolStyle, values: { conversationWidth: 1024 } }
      const saved = await app.inject({ method: 'PATCH', url: '/api/me/settings', headers: { 'x-user': id }, payload: { appearance } })
      assert.equal(saved.statusCode, 200, saved.body)
      const reread = await app.inject({ url: '/api/me/settings', headers: { 'x-user': id } })
      assert.deepEqual(reread.json().appearance, appearance)
    }
    // Un client plus ancien ne connaît pas ce champ ; ses autres préférences restent valides.
    const old = await app.inject({ method: 'PATCH', url: '/api/me/settings', headers: { 'x-user': id }, payload: { appearance: { theme: 'light', syntax: null, values: {} } } })
    assert.equal(old.statusCode, 200)
    assert.equal(old.json().appearance.toolStyle, undefined)
  }
})
