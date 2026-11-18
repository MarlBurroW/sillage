import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { MAX_BENCHMARK_PRESETS } from '@sillage/protocol'
import { benchmarkPresets, openDatabase, runMigrations, users } from '@sillage/db'
import type { AppContext } from '../src/http/context.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerBenchmarkPresetRoutes } from '../src/http/routes/benchmark-presets.js'
import { PriceCatalog } from '../src/pricing/catalog.js'

const claude = (model: string, extra: Record<string, unknown> = {}) => ({ agent: 'claude', model, effort: 'medium', permissionMode: 'bypassPermissions', ...extra })

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-presets-'))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  t.after(() => { sqlite.close(); rmSync(dir, { recursive: true, force: true }) })
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values(['owner', 'stranger'].map((id) => ({ id, username: id, displayName: id, passwordHash: '', isAdmin: false, createdAt: 1 }))).run()
  const app = Fastify()
  registerErrorHandler(app)
  app.addHook('preHandler', async (request) => { Object.assign(request, { user: { id: request.headers['x-owner'] ?? 'owner' } }) })
  registerBenchmarkPresetRoutes(app, { db } as AppContext)
  t.after(() => app.close())
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, owner = 'owner') =>
    app.inject({ method, url, headers: { 'x-owner': owner }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { db, call }
}

const body = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  variants: [{ config: claude('opus', { additionalDirectories: ['/home/someone/private'] }) }, { config: claude('haiku'), label: 'Cheap' }],
  repetitions: 2,
  concurrency: 3,
  maxDurationMinutes: 30,
  comparisons: [{ title: 'Range', variants: [0, 1] }],
  ...extra,
})

test('benchmark presets: personal, unique by name whatever the case, whole replacement', async (t) => {
  const { call } = setup(t)
  const created = await call('POST', '/api/benchmark-presets', body('Frontier'))
  assert.equal(created.statusCode, 201, created.body)
  const preset = created.json()
  assert.deepEqual([preset.repetitions, preset.concurrency, preset.maxDurationMinutes, preset.prompt, preset.checkScript], [2, 3, 30, null, null])
  assert.deepEqual(preset.variants.map((variant: { label: string | null; problem: string | null }) => [variant.label, variant.problem]), [[null, null], ['Cheap', null]])
  // Folders granted to one conversation never travel with a lineup.
  assert.deepEqual(preset.variants[0].config.additionalDirectories, [])
  assert.deepEqual(preset.comparisons, [{ title: 'Range', variants: [0, 1] }])

  assert.equal((await call('POST', '/api/benchmark-presets', body('  frontier '))).json().error.code, 'benchmark_preset_exists')
  assert.equal((await call('POST', '/api/benchmark-presets', { ...body('Bad'), variants: [] })).statusCode, 400)
  assert.equal((await call('POST', '/api/benchmark-presets', { ...body('Bad'), variants: [{ config: claude('opus', { permissionMode: 'whenever' }) }] })).statusCode, 400)

  const renamed = await call('PUT', `/api/benchmark-presets/${preset.id}`, body('Frontier 10', { prompt: 'Build a page', checkScript: 'test -f index.html' }))
  assert.equal(renamed.statusCode, 200, renamed.body)
  assert.deepEqual([renamed.json().name, renamed.json().prompt, renamed.json().checkScript], ['Frontier 10', 'Build a page', 'test -f index.html'])
  // Keeping its own name is not a conflict; taking another preset's is.
  assert.equal((await call('PUT', `/api/benchmark-presets/${preset.id}`, body('frontier 10'))).statusCode, 200)
  const other = (await call('POST', '/api/benchmark-presets', body('Claude only'))).json()
  assert.equal((await call('PUT', `/api/benchmark-presets/${other.id}`, body('FRONTIER 10'))).json().error.code, 'benchmark_preset_exists')

  // Another account sees nothing and reaches nothing.
  assert.deepEqual((await call('GET', '/api/benchmark-presets', undefined, 'stranger')).json(), [])
  assert.equal((await call('PUT', `/api/benchmark-presets/${preset.id}`, body('Mine now'), 'stranger')).statusCode, 404)
  assert.equal((await call('DELETE', `/api/benchmark-presets/${preset.id}`, undefined, 'stranger')).statusCode, 404)

  assert.equal((await call('DELETE', `/api/benchmark-presets/${other.id}`)).statusCode, 204)
  assert.deepEqual((await call('GET', '/api/benchmark-presets')).json().map((entry: { name: string }) => entry.name), ['frontier 10'])
})

test('benchmark presets: stored lineups read leniently, recently used first, a bounded number per account', async (t) => {
  const { db, call } = setup(t)
  const row = (id: string, name: string, data: unknown, lastUsedAt: number | null = null) => ({
    id, userId: 'owner', name, nameKey: name.toLowerCase(), data: JSON.stringify(data), createdAt: 1, updatedAt: 1, lastUsedAt,
  })
  db.insert(benchmarkPresets).values([
    row('old', 'Old', {
      // A permission mode the CLI has since dropped, and a configuration saved before a field existed.
      variants: [{ config: claude('opus', { permissionMode: 'gone' }), label: null }, { config: claude('haiku', { effort: 'low' }), label: 'Cheap' }],
      repetitions: 9, concurrency: 0, maxDurationMinutes: 100000, checkTimeoutSeconds: 1,
      comparisons: [{ title: null, variants: [0, 1] }, { title: null, variants: [0, 4] }],
    }, 5),
    row('broken', 'Broken', 'not an object'),
    row('recent', 'Recent', { variants: [] }, 9),
  ]).run()
  const listed = (await call('GET', '/api/benchmark-presets')).json()
  assert.deepEqual(listed.map((preset: { id: string }) => preset.id), ['recent', 'old', 'broken'])
  const old = listed[1]
  assert.deepEqual(old.variants.map((variant: { agent: string | null; problem: string | null; config: unknown }) => [variant.agent, variant.problem, variant.config === null]), [['claude', 'invalid_config', true], ['claude', null, false]])
  // Defaults fill fields added since the preset was saved.
  assert.equal(old.variants[1].config.skillLibrary !== undefined, true)
  assert.deepEqual([old.repetitions, old.concurrency, old.maxDurationMinutes, old.checkTimeoutSeconds], [5, 1, 240, 5])
  assert.deepEqual(old.comparisons, [{ title: null, variants: [0, 1] }])
  assert.deepEqual(listed[2].variants, [])
  // Reading never rewrites a row.
  assert.equal(db.select().from(benchmarkPresets).where(eq(benchmarkPresets.id, 'old')).get()!.data.includes('"gone"'), true)

  for (let index = listed.length; index < MAX_BENCHMARK_PRESETS; index++) {
    assert.equal((await call('POST', '/api/benchmark-presets', body(`Preset ${index}`))).statusCode, 201)
  }
  assert.equal((await call('POST', '/api/benchmark-presets', body('One too many'))).json().error.code, 'benchmark_preset_limit')
})

test('benchmark presets: variants carry the reference name and price of a concrete model, never of an alias', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-presets-prices-'))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  t.after(() => { sqlite.close(); rmSync(dir, { recursive: true, force: true }) })
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', isAdmin: false, createdAt: 1 }).run()
  // The shipped lists, offline: a CLI too old to list a model must not make the form forget it.
  const prices = new PriceCatalog(db, async () => { throw new Error('offline') })
  const app = Fastify()
  registerErrorHandler(app)
  app.addHook('preHandler', async (request) => { Object.assign(request, { user: { id: 'owner' } }) })
  registerBenchmarkPresetRoutes(app, { db } as AppContext, prices)
  t.after(() => app.close())
  const codex = { agent: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'medium', askForApproval: 'never', sandbox: 'danger-full-access' }
  const created = await app.inject({ method: 'POST', url: '/api/benchmark-presets', payload: {
    name: 'Mixed', variants: [{ config: codex }, { config: claude('opus') }], repetitions: 1, concurrency: 1, maxDurationMinutes: 20,
  } })
  assert.equal(created.statusCode, 201, created.body)
  const [sol, opus] = created.json().variants
  assert.deepEqual([sol.model, sol.publicName, sol.listPrice?.output], ['gpt-6.2-sol', 'GPT-6.2 Sol', 10])
  assert.deepEqual([opus.model, opus.publicName, opus.listPrice], [null, null, null])
})
