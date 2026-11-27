import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { benchmarkPresets, benchmarkRuns, benchmarks as benchmarkTable, conversations, openDatabase, runMigrations, users } from '@sillage/db'
import { BenchmarkRunner, benchmarkInputDir } from '../src/benchmarks/runner.js'
import type { AppContext } from '../src/http/context.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerAgentRoutes } from '../src/http/routes/agents.js'
import { registerBenchmarkRoutes } from '../src/http/routes/benchmarks.js'
import { PriceCatalog } from '../src/pricing/catalog.js'
import { findName, reduceModelsDev } from '../src/pricing/prices.js'

const claude = (model: string, effort = 'medium') => ({ agent: 'claude', model, effort, permissionMode: 'bypassPermissions' })
const codex = (model: string) => ({ agent: 'codex', model, reasoningEffort: 'medium', askForApproval: 'never', sandbox: 'danger-full-access' })

function setup(t: TestContext, options: { prices?: boolean; disabled?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-lineup-'))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  t.after(() => { sqlite.close(); rmSync(dir, { recursive: true, force: true }) })
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values([
    { id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', isAdmin: false, createdAt: 1 },
    { id: 'stranger', username: 'stranger', displayName: 'stranger', passwordHash: '', isAdmin: false, createdAt: 1 },
  ]).run()
  const ctx = { db, config: { paths: { data: dir } } } as unknown as AppContext
  const terminated: string[] = []
  const sessions = {
    assertCliEnabled: (agent: string) => {
      if (options.disabled?.includes(agent)) throw Object.assign(new Error(`${agent} is disabled`), { statusCode: 503, code: 'cli_disabled' })
    },
    terminate: async (id: string) => { terminated.push(id) },
    dropCheckpoints: async () => undefined,
  }
  const registry = { adapter: () => ({ resolveDefaults: async (config: unknown) => config }) }
  const attachments = { listClaimable: () => [], remove: async () => undefined, removeForConversations: async () => undefined }
  const prices = options.prices ? new PriceCatalog(db, async () => { throw new Error('offline') }) : null
  const runner = new BenchmarkRunner(ctx, sessions as never, registry as never, {} as never, attachments as never, prices)
  runner.kick = () => undefined
  const app = Fastify()
  registerErrorHandler(app)
  app.addHook('preHandler', async (request) => { Object.assign(request, { user: { id: request.headers['x-owner'] ?? 'owner' } }) })
  registerBenchmarkRoutes(app, ctx, runner)
  t.after(() => app.close())
  return { db, dir, ctx, runner, app, terminated }
}

type Db = ReturnType<typeof setup>['db']

function insertBenchmark(db: Db, id: string, variants: { id: string; label: string; config: unknown }[], extra: Partial<typeof benchmarkTable.$inferInsert> = {}) {
  db.insert(benchmarkTable).values({
    id, userId: 'owner', name: id, prompt: 'test', variants: JSON.stringify(variants), repetitions: 1, concurrency: 'sequential',
    maxConcurrentRuns: 1, maxDurationMinutes: 20, createdAt: 1, updatedAt: 1, ...extra,
  }).run()
}

function insertRun(db: Db, benchmarkId: string, variantId: string, repetition: number, status: string, extra: Record<string, unknown> = {}) {
  db.insert(benchmarkRuns).values({ id: `${benchmarkId}-${variantId}-${repetition}`, benchmarkId, variantId, repetition, status: status as never, ...extra }).run()
}

const stored = (db: Db, id: string) => JSON.parse(db.select().from(benchmarkTable).where(eq(benchmarkTable.id, id)).get()!.variants) as { id: string; label: string; config: unknown; addedAt?: number }[]

test('benchmark order: pending runs launch in rounds across the lineup, never v10 before v2', async (t) => {
  const { db, runner } = setup(t)
  const twelve = Array.from({ length: 12 }, (_, index) => ({ id: `v${index + 1}`, label: `m${index + 1}`, config: claude('default') }))
  insertBenchmark(db, 'twelve', twelve, { repetitions: 2, maxConcurrentRuns: 60, createdAt: 1 })
  for (const variant of twelve) for (const repetition of [1, 2]) insertRun(db, 'twelve', variant.id, repetition, 'pending')
  insertBenchmark(db, 'shuffled', ['v3', 'v1', 'v2'].map((id) => ({ id, label: id, config: claude('default') })), { maxConcurrentRuns: 60, createdAt: 2 })
  for (const id of ['v1', 'v2', 'v3']) insertRun(db, 'shuffled', id, 1, 'pending')

  const started: string[] = []
  const scheduler = runner as unknown as { launchPending(): Promise<void>; launch(run: { id: string }): Promise<void>; launching: Set<string> }
  scheduler.launch = async (run) => { started.push(run.id); scheduler.launching.add(run.id) }
  await scheduler.launchPending()
  const expected = [
    ...twelve.map((variant) => `twelve-${variant.id}-1`),
    ...twelve.map((variant) => `twelve-${variant.id}-2`),
    'shuffled-v3-1', 'shuffled-v1-1', 'shuffled-v2-1',
  ]
  assert.deepEqual(started, expected)

  // Pages and exports read runs in the same order: variant by variant, then repetition.
  const listed = runner.list('owner')
  const order = (id: string) => listed.find((entry) => entry.id === id)!.runs.map((run) => `${run.variantId}:${run.repetition}`)
  assert.deepEqual(order('twelve').slice(0, 6), ['v1:1', 'v1:2', 'v2:1', 'v2:2', 'v3:1', 'v3:2'])
  assert.deepEqual(order('shuffled'), ['v3:1', 'v1:1', 'v2:1'])
})

test('benchmark names: public names from models.dev, effort only when efforts differ, labels written by the user stay', (t) => {
  const { db, runner } = setup(t, { prices: true })
  insertBenchmark(db, 'same', [
    { id: 'opus', label: 'opus · medium', config: claude('opus') },
    { id: 'astra', label: 'gpt-6.2-astra · medium', config: codex('gpt-6.2-astra') },
    { id: 'mine', label: 'My pick', config: claude('haiku') },
    { id: 'waiting', label: 'haiku · medium', config: claude('haiku') },
  ])
  insertRun(db, 'same', 'opus', 1, 'succeeded', { metrics: JSON.stringify({ model: 'claude-opus-5-5' }) })
  insertRun(db, 'same', 'mine', 1, 'succeeded', { metrics: JSON.stringify({ model: 'claude-haiku-5-5' }) })
  insertBenchmark(db, 'efforts', [
    { id: 'low', label: 'opus · low', config: claude('opus', 'low') },
    { id: 'high', label: 'opus · high', config: claude('opus', 'high') },
  ], { createdAt: 2 })
  for (const id of ['low', 'high']) insertRun(db, 'efforts', id, 1, 'succeeded', { metrics: JSON.stringify({ model: 'claude-opus-5-5' }) })

  const listed = runner.list('owner')
  const same = listed.find((entry) => entry.id === 'same')!.variants
  assert.deepEqual(same.map((variant) => variant.label), ['Opus 5.5', 'GPT-6.2 Astra', 'My pick', 'haiku · medium'])
  assert.deepEqual(same.map((variant) => variant.technicalLabel), ['claude-opus-5-5 · medium', 'gpt-6.2-astra · medium', 'claude-haiku-5-5 · medium', 'haiku · medium'])
  // An alias is only named and priced once a run announced the model behind it.
  assert.deepEqual(same.map((variant) => variant.model), ['claude-opus-5-5', 'gpt-6.2-astra', 'claude-haiku-5-5', null])
  assert.deepEqual(same.map((variant) => variant.listPrice && [variant.listPrice.input, variant.listPrice.output]), [[4, 20], [8, 40], [0.1, 0.5], null])
  assert.equal('name' in same[0]!.listPrice!, false, 'list prices travel as rates only')
  assert.deepEqual(same.map((variant) => variant.labelIsCustom), [false, false, true, false])
  const efforts = listed.find((entry) => entry.id === 'efforts')!.variants
  assert.deepEqual(efforts.map((variant) => variant.label), ['Opus 5.5 · low', 'Opus 5.5 · high'])
})

test('benchmark lineup: continuing adds variants with series-wide ids, queues their runs, keeps frozen configs', async (t) => {
  const { db, runner, app } = setup(t)
  const original = [{ id: 'v1', label: 'default · low', config: claude('default', 'low') }, { id: 'v2', label: 'sonnet · medium', config: claude('sonnet') }]
  insertBenchmark(db, 'original', original, { repetitions: 2 })
  for (const variant of original) for (const repetition of [1, 2]) insertRun(db, 'original', variant.id, repetition, 'succeeded')
  const copy = await runner.rerun('original', 'owner')

  await runner.updateLineup(copy.id, 'owner', {
    variants: [{ id: 'v2', label: null }, { id: 'v1', label: 'Fast one' }, { config: claude('opus') as never, label: null }],
    confirmRemoval: false,
  })
  const continued = stored(db, copy.id)
  assert.deepEqual(continued.map((variant) => variant.id), ['v2', 'v1', 'v3'])
  assert.deepEqual(continued.map((variant) => variant.label), ['sonnet · medium', 'Fast one', 'opus · medium'])
  assert.equal(typeof continued[2]!.addedAt, 'number')
  // Frozen configurations go back byte for byte: no default of today slips into what ran.
  assert.equal(JSON.stringify(continued[1]!.config), JSON.stringify(original[0]!.config))
  const runs = db.select().from(benchmarkRuns).where(eq(benchmarkRuns.benchmarkId, copy.id)).all()
  assert.deepEqual(runs.filter((run) => run.variantId === 'v3').map((run) => [run.repetition, run.status]).sort(), [[1, 'pending'], [2, 'pending']])

  // The original gains a variant too: v3 is taken in its series, so it gets v4.
  await runner.updateLineup('original', 'owner', { variants: [{ id: 'v1', label: null }, { id: 'v2', label: null }, { config: codex('gpt-6-astra') as never, label: 'Astra' }], confirmRemoval: false })
  assert.deepEqual(stored(db, 'original').map((variant) => [variant.id, variant.label]), [['v1', 'default · low'], ['v2', 'sonnet · medium'], ['v4', 'Astra']])

  // A label set back to null shows the automatic name again.
  await runner.updateLineup(copy.id, 'owner', { variants: [{ id: 'v2', label: null }, { id: 'v1', label: null }, { id: 'v3', label: null }], confirmRemoval: false })
  assert.equal(stored(db, copy.id)[1]!.label, 'default · low')

  // A rerun measures the whole lineup at once: nothing in it was added later.
  const again = await runner.rerun(copy.id, 'owner')
  assert.deepEqual(stored(db, again.id).map((variant) => [variant.id, 'addedAt' in variant]), [['v2', false], ['v1', false], ['v3', false]])

  const put = (id: string, payload: unknown, owner = 'owner') => app.inject({ method: 'PUT', url: `/api/benchmarks/${id}/lineup`, headers: { 'x-owner': owner }, payload: payload as object })
  assert.equal((await put('original', { variants: [{ id: 'v1', label: null }] }, 'stranger')).statusCode, 404)
  assert.equal((await put('original', { variants: [] })).statusCode, 400)
  assert.equal((await put('original', { variants: [{ id: 'v1', label: null }, { id: 'v1', label: null }, { id: 'v2', label: null }, { id: 'v4', label: null }] })).json().error.code, 'benchmark_lineup_duplicate')
  assert.equal((await put('original', { variants: [{ id: 'v9', label: null }] })).json().error.code, 'benchmark_lineup_changed')
  const tooMany = Array.from({ length: 13 }, () => ({ config: claude('haiku') }))
  assert.equal((await put('original', { variants: [{ id: 'v1', label: null }, ...tooMany] })).json().error.code, 'benchmark_variants_per_launch')
  // A tab that never saw v4 arrive would delete it by leaving it out: its base gives it away.
  const stale = await put('original', { variants: [{ id: 'v1', label: 'Renamed' }, { id: 'v2', label: null }], base: ['v1', 'v2'] })
  assert.equal(stale.statusCode, 409)
  assert.equal(stale.json().error.code, 'benchmark_lineup_changed')
  const ok = await put('original', { variants: [{ id: 'v4', label: null }, { id: 'v1', label: null }, { id: 'v2', label: null }], base: ['v1', 'v2', 'v4'] })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.deepEqual(ok.json().variants.map((variant: { id: string }) => variant.id), ['v4', 'v1', 'v2'])
})

test('benchmark lineup: the total stays capped and a disabled CLI changes nothing', async (t) => {
  const { db, runner } = setup(t, { disabled: ['grok'] })
  const many = Array.from({ length: 23 }, (_, index) => ({ id: `v${index + 1}`, label: `m${index + 1}`, config: claude('default') }))
  insertBenchmark(db, 'big', many)
  const before = db.select().from(benchmarkTable).where(eq(benchmarkTable.id, 'big')).get()!.variants
  const keep = many.map((variant) => ({ id: variant.id, label: null }))
  await assert.rejects(runner.updateLineup('big', 'owner', { variants: [...keep, { config: claude('opus') as never, label: null }, { config: claude('haiku') as never, label: null }], confirmRemoval: false }), { code: 'benchmark_variants_limit' })
  await assert.rejects(runner.updateLineup('big', 'owner', { variants: [...keep, { config: { agent: 'grok', model: 'grok-5' } as never, label: null }], confirmRemoval: false }), /disabled/)
  assert.equal(db.select().from(benchmarkTable).where(eq(benchmarkTable.id, 'big')).get()!.variants, before)
  assert.equal(db.select().from(benchmarkRuns).all().length, 0)
  await runner.updateLineup('big', 'owner', { variants: [...keep, { config: claude('opus') as never, label: null }], confirmRemoval: false })
  assert.equal(stored(db, 'big').length, 24)
})

test('benchmark lineup: removing a variant deletes its runs only once confirmed, never while one runs', async (t) => {
  const { db, runner, terminated } = setup(t)
  const lineup = ['done', 'queued', 'busy', 'starting'].map((id) => ({ id, label: id, config: claude('default') }))
  insertBenchmark(db, 'bench', lineup, {
    comparisons: JSON.stringify([
      { id: 'pair', title: null, variantIds: ['done', 'queued'] },
      { id: 'trio', title: 'Range', variantIds: ['done', 'busy', 'starting'] },
    ]),
  })
  db.insert(conversations).values({ id: 'thread', userId: 'owner', title: 'run', agent: 'claude', status: 'idle', config: '{}', createdAt: 1, updatedAt: 1, benchmarkId: 'bench' }).run()
  insertRun(db, 'bench', 'done', 1, 'succeeded', { conversationId: 'thread' })
  insertRun(db, 'bench', 'queued', 1, 'pending')
  insertRun(db, 'bench', 'busy', 1, 'running', { conversationId: 'busy-thread' })
  insertRun(db, 'bench', 'starting', 1, 'pending')
  ;(runner as unknown as { launching: Set<string> }).launching.add('bench-starting-1')
  const without = (...removed: string[]) => lineup.filter((variant) => !removed.includes(variant.id)).map((variant) => ({ id: variant.id, label: null }))

  // Never started: it simply goes, with its pending run. Comparisons left with one contestant go too.
  await runner.updateLineup('bench', 'owner', { variants: without('queued'), confirmRemoval: false })
  assert.deepEqual(stored(db, 'bench').map((variant) => variant.id), ['done', 'busy', 'starting'])
  assert.equal(db.select().from(benchmarkRuns).where(eq(benchmarkRuns.variantId, 'queued')).all().length, 0)
  assert.deepEqual(runner.list('owner')[0]!.comparisons.map((comparison) => comparison.id), ['trio'])

  await assert.rejects(runner.updateLineup('bench', 'owner', { variants: without('queued', 'busy'), confirmRemoval: true }), { code: 'benchmark_variant_running' })
  await assert.rejects(runner.updateLineup('bench', 'owner', { variants: without('queued', 'starting'), confirmRemoval: true }), { code: 'benchmark_variant_running' })
  await assert.rejects(runner.updateLineup('bench', 'owner', { variants: without('queued', 'done'), confirmRemoval: false }), { code: 'benchmark_variant_removal_unconfirmed' })
  assert.equal(db.select().from(conversations).where(eq(conversations.id, 'thread')).get()?.id, 'thread', 'a refused removal touches nothing')

  await runner.updateLineup('bench', 'owner', { variants: without('queued', 'done'), confirmRemoval: true })
  assert.deepEqual(stored(db, 'bench').map((variant) => variant.id), ['busy', 'starting'])
  assert.equal(db.select().from(benchmarkRuns).where(eq(benchmarkRuns.variantId, 'done')).all().length, 0)
  // Its thread goes with it, as when a whole benchmark is deleted.
  assert.equal(db.select().from(conversations).where(eq(conversations.id, 'thread')).get(), undefined)
  assert.ok(terminated.includes('thread'))
  // The trio lost a contestant but still compares two.
  assert.deepEqual(runner.list('owner')[0]!.comparisons, [{ id: 'trio', title: 'Range', variantIds: ['busy', 'starting'] }])
})

test('benchmark comparisons: validated, replaced whole, filtered on read, copied by reruns', async (t) => {
  const { db, runner, app } = setup(t)
  insertBenchmark(db, 'bench', ['v1', 'v2', 'v3'].map((id) => ({ id, label: id, config: claude('default') })))
  const put = (comparisons: unknown, owner = 'owner') => app.inject({ method: 'PUT', url: '/api/benchmarks/bench/comparisons', headers: { 'x-owner': owner }, payload: { comparisons } as object })
  const saved = await put([{ id: 'a', title: 'Mid range', variantIds: ['v1', 'v2'] }, { id: 'b', variantIds: ['v1', 'v2', 'v3'] }])
  assert.equal(saved.statusCode, 200, saved.body)
  assert.deepEqual(saved.json().comparisons, [{ id: 'a', title: 'Mid range', variantIds: ['v1', 'v2'] }, { id: 'b', title: null, variantIds: ['v1', 'v2', 'v3'] }])
  assert.equal((await put([{ id: 'x', variantIds: ['v1', 'v9'] }])).json().error.code, 'benchmark_comparison_unknown')
  assert.equal((await put([{ id: 'x', variantIds: ['v1', 'v1'] }])).json().error.code, 'benchmark_comparison_repeated')
  assert.equal((await put([{ id: 'x', variantIds: ['v1', 'v2'] }, { id: 'x', variantIds: ['v2', 'v3'] }])).json().error.code, 'benchmark_comparison_duplicate')
  assert.equal((await put([{ id: 'x', variantIds: ['v1'] }])).statusCode, 400)
  assert.equal((await put([], 'stranger')).statusCode, 404)

  const copy = await runner.rerun('bench', 'owner')
  assert.deepEqual(runner.list('owner').find((entry) => entry.id === copy.id)!.comparisons.map((comparison) => comparison.id), ['a', 'b'])

  // A stored id the lineup no longer has is left out on read rather than shown dangling.
  db.update(benchmarkTable).set({ comparisons: JSON.stringify([{ id: 'c', title: null, variantIds: ['v1', 'gone'] }, { id: 'd', title: null, variantIds: ['v1', 'v2', 'gone'] }]) }).where(eq(benchmarkTable.id, 'bench')).run()
  assert.deepEqual(runner.list('owner').find((entry) => entry.id === 'bench')!.comparisons, [{ id: 'd', title: null, variantIds: ['v1', 'v2'] }])
  assert.equal((await put([])).json().comparisons.length, 0)
  assert.equal(db.select().from(benchmarkTable).where(eq(benchmarkTable.id, 'bench')).get()!.comparisons, null)
})

test('benchmark creation: starting files of another benchmark, comparisons by position, the preset marked used', async (t) => {
  const { db, dir, app } = setup(t)
  const source = '11111111-1111-4111-8111-111111111111'
  const foreign = '22222222-2222-4222-8222-222222222222'
  insertBenchmark(db, source, [{ id: 'v1', label: 'v1', config: claude('default') }], {
    inputs: JSON.stringify([{ storedAs: '1-brief.txt', filename: 'brief.txt', mimeType: 'text/plain', sizeBytes: 5 }]),
  })
  mkdirSync(benchmarkInputDir(dir, source), { recursive: true })
  writeFileSync(join(benchmarkInputDir(dir, source), '1-brief.txt'), 'hello')
  insertBenchmark(db, foreign, [{ id: 'v1', label: 'v1', config: claude('default') }], { userId: 'stranger' })
  const mine = '00000000-0000-4000-8000-000000000001'
  const theirs = '00000000-0000-4000-8000-000000000002'
  db.insert(benchmarkPresets).values([
    { id: mine, userId: 'owner', name: 'Mine', nameKey: 'mine', data: '{}', createdAt: 1, updatedAt: 1 },
    { id: theirs, userId: 'stranger', name: 'Theirs', nameKey: 'theirs', data: '{}', createdAt: 1, updatedAt: 1 },
  ]).run()
  const create = (extra: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/benchmarks', payload: {
    name: 'again', prompt: 'test', variants: [{ config: claude('opus') }, { config: claude('sonnet') }, { config: codex('gpt-6.1-terra') }], ...extra,
  } })

  const response = await create({
    inputsFrom: source,
    comparisons: [{ title: 'Range', variants: [0, 2] }, { variants: [1, 1] }, { variants: [0, 5] }],
    presetId: mine,
  })
  assert.equal(response.statusCode, 201, response.body)
  const dto = response.json()
  assert.deepEqual(dto.inputs, [{ filename: 'brief.txt', mimeType: 'text/plain', sizeBytes: 5 }])
  assert.equal(readFileSync(join(benchmarkInputDir(dir, dto.id), '1-brief.txt'), 'utf8'), 'hello')
  // Comparisons arrive by position; the repeated and the out-of-range ones are dropped.
  assert.deepEqual(dto.comparisons.map((comparison: { title: string | null; variantIds: string[] }) => [comparison.title, comparison.variantIds]), [['Range', ['v1', 'v3']]])
  const presets = db.select().from(benchmarkPresets).all()
  assert.ok(presets.find((preset) => preset.id === mine)!.lastUsedAt)

  // Another account's benchmark lends no files, and its preset is never touched.
  assert.equal((await create({ inputsFrom: foreign })).statusCode, 404)
  assert.equal((await create({ presetId: theirs })).statusCode, 201)
  assert.equal(db.select().from(benchmarkPresets).where(eq(benchmarkPresets.id, theirs)).get()!.lastUsedAt, null)
  // Starting files stay within the per-message limit, copied ones included.
  const ids = Array.from({ length: 5 }, (_, index) => `00000000-0000-4000-8000-00000000001${index}`)
  assert.equal((await create({ inputsFrom: source, attachmentIds: ids })).json().error.code, 'benchmark_inputs_limit')
  assert.equal(existsSync(join(benchmarkInputDir(dir, dto.id), '1-brief.txt')), true)
})

test('a cancel during CLI startup leaves no unmeasured session', async (t) => {
  const { db, runner, terminated } = setup(t)
  insertBenchmark(db, 'bench', [{ id: 'v1', label: 'v1', config: claude('default') }])
  insertRun(db, 'bench', 'v1', 1, 'cancelled', { finishedAt: 5, error: 'Cancelled before launch.' })
  insertRun(db, 'bench', 'v1', 2, 'pending')
  const start = (runner as unknown as { recordStart(runId: string, conversationId: string, startedAt: number, cliVersion: string | null): Promise<void> }).recordStart.bind(runner)

  await start('bench-v1-1', 'late-thread', 3, '2.1.0')
  const cancelled = db.select().from(benchmarkRuns).where(eq(benchmarkRuns.id, 'bench-v1-1')).get()!
  assert.deepEqual([cancelled.status, cancelled.conversationId, cancelled.previewToken], ['cancelled', 'late-thread', null])
  assert.deepEqual(terminated, ['late-thread'])

  await start('bench-v1-2', 'thread', 4, '2.1.0')
  const running = db.select().from(benchmarkRuns).where(eq(benchmarkRuns.id, 'bench-v1-2')).get()!
  assert.deepEqual([running.status, running.conversationId, running.cliVersion], ['running', 'thread', '2.1.0'])
  assert.ok(running.previewToken)
  assert.deepEqual(terminated, ['late-thread'])
})

test('model catalogs carry list prices and public names, aliases through the model they resolve to', async (t) => {
  const { db, ctx } = setup(t)
  const prices = new PriceCatalog(db, async () => { throw new Error('offline') })
  assert.equal(prices.priceOf('opus'), null, 'an alias is in no price list')
  assert.equal(prices.nameOf('gpt-6.2-astra'), 'GPT-6.2 Astra')
  assert.equal(prices.nameOf('claude-opus-5-5[1m]'), 'Claude Opus 5.5')

  const models = [
    { value: 'opus', displayName: 'Opus 5.5', description: '', hint: 'claude-opus-5-5', isDefault: false, efforts: [], defaultEffort: null, supportsFastMode: false },
    { value: 'gpt-6-astra', displayName: 'gpt-6-astra', description: '', hint: null, isDefault: true, efforts: [], defaultEffort: null, supportsFastMode: false },
    { value: 'unlisted-model', displayName: 'Unlisted', description: '', hint: null, isDefault: false, efforts: [], defaultEffort: null, supportsFastMode: false },
  ]
  const adapter = { kind: 'claude', label: 'Claude Code', models: async () => ({ models, modes: [], account: null, outputStyles: [], fastMode: null, agents: [] }) }
  const registry = { find: () => adapter, all: () => [adapter] }
  const register = (catalog: PriceCatalog | null) => {
    const app = Fastify()
    registerErrorHandler(app)
    app.addHook('preHandler', async (request) => { Object.assign(request, { user: { id: 'owner' } }) })
    registerAgentRoutes(app, ctx, registry as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, catalog)
    t.after(() => app.close())
    return app
  }
  const listed = (await register(prices).inject({ url: '/api/agents/claude/models' })).json().models
  assert.deepEqual(listed.map((model: { listPrice: { input: number; output: number } | null }) => model.listPrice && [model.listPrice.input, model.listPrice.output]), [[4, 20], [10, 50], null])
  assert.deepEqual(listed.map((model: { publicName: string | null }) => model.publicName), ['Claude Opus 5.5', 'GPT-6 Astra', null])
  const plain = (await register(null).inject({ url: '/api/agents/claude/models' })).json().models
  assert.equal('listPrice' in plain[0], false, 'without a price list, models are listed as the CLI reports them')
})

test('models.dev names are kept, looked up like prices, and fetched again when a stored list predates them', async (t) => {
  const table = reduceModelsDev({
    anthropic: { models: { 'claude-opus-5-5': { name: ' Claude Opus 5.5 ', cost: { input: 4, output: 20 } } } },
    openai: { models: { 'gpt-6.1-terra': { name: 'GPT-6.1 Terra', cost: { input: 1, output: 5 } }, nameless: { cost: { input: 1, output: 1 } } } },
  })
  assert.equal(table['anthropic/claude-opus-5-5']!.name, 'Claude Opus 5.5')
  assert.equal('name' in table['openai/nameless']!, false)
  assert.equal(findName([{}, table], 'claude-opus-5-5-20260922'), 'Claude Opus 5.5')
  assert.equal(findName([table], 'gpt-6.1-terra'), 'GPT-6.1 Terra')
  assert.equal(findName([table], 'nameless'), null)

  // A models.dev list stored before names were kept: its ETag must not be sent, or the server
  // answers 304 and the list is never reduced again.
  const { db } = setup(t)
  const { priceCatalogs } = await import('@sillage/db')
  db.insert(priceCatalogs).values({ source: 'modelsdev', data: JSON.stringify({ 'openai/gpt-6.1-terra': { input: 1, output: 5, cacheRead: null, cacheWrite: null, cacheWrite1h: null } }), etag: '"old"', fetchedAt: 1, checkedAt: 1 }).run()
  const sent: Record<string, string | undefined> = {}
  const catalog = new PriceCatalog(db, async (url, init) => {
    sent[url] = init.headers['if-none-match']
    throw new Error('offline')
  })
  // Before any refresh, names still come from the shipped list.
  assert.equal(catalog.nameOf('gpt-6.1-terra'), 'GPT-6.1 Terra')
  await catalog.refresh()
  assert.equal(sent['https://models.dev/api.json'], undefined)
})
