import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { benchmarkRuns, benchmarks, conversations, events, openDatabase, projects, runMigrations, turnUsage, users } from '@sillage/db'
import type { ConsumptionReport, ConversationStatsDto, SillageEvent } from '@sillage/protocol'
import { antigravityTurnTokens } from '../src/agents/antigravity/usage.js'
import { runCostUsd } from '../src/benchmarks/cost.js'
import { computeRunMetrics } from '../src/benchmarks/metrics.js'
import { TurnUsageRecorder } from '../src/consumption/recorder.js'
import { consumptionReport } from '../src/consumption/report.js'
import { claudeTurnCost, claudeTurnUsage, turnUsageOf } from '../src/consumption/turn-usage.js'
import { EventLog } from '../src/events/event-log.js'
import type { AppContext } from '../src/http/context.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerConsumptionRoutes } from '../src/http/routes/consumption.js'
import { PriceCatalog, PRICE_SOURCES } from '../src/pricing/catalog.js'
import { costOf, findPrice, priceKeys, reduceLitellm, reduceModelsDev } from '../src/pricing/prices.js'

const litellm = {
  sample_spec: { input_cost_per_token: 0, litellm_provider: 'one of: openai', mode: 'chat' },
  'claude-opus-5-5': { litellm_provider: 'anthropic', mode: 'chat', input_cost_per_token: 4e-6, output_cost_per_token: 2e-5, cache_read_input_token_cost: 2e-7, cache_creation_input_token_cost: 5e-6, cache_creation_input_token_cost_above_1hr: 8e-6 },
  'gpt-6-astra': { litellm_provider: 'openai', mode: 'responses', input_cost_per_token: 1e-5, output_cost_per_token: 5e-5, cache_read_input_token_cost: 1e-6 },
  'xai/grok-4.7': { litellm_provider: 'xai', mode: 'chat', input_cost_per_token: 2e-6, output_cost_per_token: 6e-6 },
  // A reseller's markup on the same name must never be picked.
  'azure/gpt-6-astra': { litellm_provider: 'azure', mode: 'chat', input_cost_per_token: 9e-5, output_cost_per_token: 9e-5 },
  'gpt-image': { litellm_provider: 'openai', mode: 'image_generation', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
}
const modelsDev = {
  opencode: { models: { 'glm-5.2': { cost: { input: 1.4, output: 4.4, cache_read: 0.26 } }, 'free-one': { cost: { input: 0, output: 0 } } } },
  anthropic: { models: { 'claude-opus-5-5': { cost: { input: 99, output: 99 } } } },
  reseller: { models: { 'glm-5.2': { cost: { input: 50, output: 50 } } } },
}

function database(t: TestContext) {
  const { db, sqlite } = openDatabase(':memory:')
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  for (const [id, isAdmin] of [['admin', true], ['alice', false]] as const) db.insert(users).values({ id, username: id, displayName: id.toUpperCase(), passwordHash: '', isAdmin, createdAt: 1 }).run()
  db.insert(projects).values({ id: 'p', name: 'Project', workspacePath: '/tmp', ownerId: 'alice', visibility: 'shared', createdAt: 1 }).run()
  return db
}

function conversation(db: ReturnType<typeof database>, id: string, agent: 'claude' | 'codex' | 'antigravity', extra: Partial<typeof conversations.$inferInsert> = {}) {
  db.insert(conversations).values({ id, projectId: 'p', userId: 'alice', title: id, agent, status: 'idle', config: '{}', createdAt: 1, updatedAt: 1, ...extra } as typeof conversations.$inferInsert).run()
}

const completed = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheCreationTokens = 0, costUsd = 0): Extract<SillageEvent, { type: 'turn.completed' }> =>
  ({ type: 'turn.completed', stopReason: 'completed', costUsd, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens })

const counters = (inputTokens: number, outputTokens: number, costUSD: number, written = 0, hour?: number) =>
  ({ inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: written, costUSD, ...(hour === undefined ? {} : { cacheCreationEphemeral1hInputTokens: hour }) })

/** A catalog that never reaches the network unless a test hands it a download. */
function catalog(db: ReturnType<typeof database>, download?: ConstructorParameters<typeof PriceCatalog>[1], now?: () => number) {
  return new PriceCatalog(db, download ?? (async () => { throw new Error('offline') }), now)
}

const answers = (bodies: Record<string, unknown>, etag = '"v1"') => async (url: string, init: { headers: Record<string, string> }) => {
  if (init.headers['if-none-match'] === etag) return { status: 304, ok: false, headers: new Headers(), json: async () => null }
  return { status: 200, ok: true, headers: new Headers({ etag }), json: async () => bodies[url] }
}

test('price lists keep vendors, chat models and per-million rates', () => {
  const table = reduceLitellm(litellm)
  assert.deepEqual(Object.keys(table).sort(), ['claude-opus-5-5', 'gpt-6-astra', 'xai/grok-4.7'])
  assert.deepEqual(table['claude-opus-5-5'], { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 })
  assert.deepEqual(table['gpt-6-astra'], { input: 10, output: 50, cacheRead: 1, cacheWrite: null, cacheWrite1h: null })
  const fallback = reduceModelsDev(modelsDev)
  assert.deepEqual(Object.keys(fallback).sort(), ['anthropic/claude-opus-5-5', 'opencode/free-one', 'opencode/glm-5.2'])
  assert.deepEqual(reduceLitellm('not a list'), {})
  assert.deepEqual(reduceModelsDev(null), {})
})

test('a CLI model name finds its price through decorations and vendor prefixes', () => {
  const tables = [reduceLitellm(litellm), reduceModelsDev(modelsDev)]
  assert.equal(findPrice(tables, 'claude-opus-5-5[1m]')?.input, 4)
  assert.equal(findPrice(tables, 'Claude-Opus-5-5-20260922')?.input, 4)
  assert.equal(findPrice(tables, 'grok-4.7')?.output, 6)
  assert.equal(findPrice(tables, 'opencode/glm-5.2')?.input, 1.4)
  assert.equal(findPrice(tables, 'opencode/free-one')?.input, 0)
  // A name listed as given wins over a looser match, whichever list holds it: a gateway's own
  // price for a model is not its vendor's.
  assert.equal(findPrice(tables, 'anthropic/claude-opus-5-5')?.input, 99)
  assert.equal(findPrice(tables, 'unknown-model'), null)
  assert.equal(findPrice(tables, ''), null)
  assert.deepEqual(priceKeys('  '), [])
})

test('cost applies each rate and falls back on cheaper assumptions for missing ones', () => {
  const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 1_000_000 }
  assert.equal(costOf({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 }, tokens), 37.2)
  assert.equal(costOf({ input: 4, output: 20, cacheRead: null, cacheWrite: null, cacheWrite1h: null }, tokens), 36)
  assert.equal(costOf({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: null }, tokens), 34.2)
})

test('a Claude result gives per-model usage, from its own counters or cumulative ones', () => {
  const own = claudeTurnUsage({ type: 'result', model_usage_since_last_result: { main: counters(10, 20, 0.5, 100, 60), aux: counters(1, 2, 0.01) }, modelUsage: { main: counters(999, 999, 9) } }, null)
  assert.deepEqual(own?.rows, [
    { model: 'main', inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 40, cacheWrite1hTokens: 60, reportedCostUsd: 0.5 },
    { model: 'aux', inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reportedCostUsd: 0.01 },
  ])

  // Older results: cumulative counters only, and the write lifetimes for the turn as a whole.
  const usage = { cache_creation: { ephemeral_1h_input_tokens: 30, ephemeral_5m_input_tokens: 10 } }
  const first = claudeTurnUsage({ type: 'result', usage, modelUsage: { main: counters(10, 20, 1, 40) } }, null)
  assert.deepEqual(first?.rows.map((row) => [row.inputTokens, row.cacheWriteTokens, row.cacheWrite1hTokens, row.reportedCostUsd]), [[10, 10, 30, 1]])
  const second = claudeTurnUsage({ type: 'result', modelUsage: { main: counters(25, 50, 2.5, 40), aux: counters(3, 4, 0.1) } }, first!.cumulative)
  assert.deepEqual(second?.rows.map((row) => [row.model, row.inputTokens, row.outputTokens, row.reportedCostUsd]), [['main', 15, 30, 1.5], ['aux', 3, 4, 0.1]])
  // Counters going backwards: the CLI process restarted and counts from zero.
  const restarted = claudeTurnUsage({ type: 'result', modelUsage: { main: counters(5, 6, 0.2) } }, second!.cumulative)
  assert.deepEqual(restarted?.rows.map((row) => [row.inputTokens, row.outputTokens, row.reportedCostUsd]), [[5, 6, 0.2]])

  assert.equal(claudeTurnUsage({ type: 'result' }, null), null)
  assert.equal(claudeTurnUsage({ type: 'assistant', modelUsage: { main: counters(1, 1, 1) } }, null), null)
})

test('a Claude turn costs its share of the process total, not the total', () => {
  assert.equal(claudeTurnCost({ total_cost_usd: 3 }, 0), 3)
  assert.equal(claudeTurnCost({ total_cost_usd: 8 }, 3), 5)
  assert.equal(claudeTurnCost({ total_cost_usd: 2 }, 8), 2)
  assert.equal(claudeTurnCost({ total_cost_usd: 8, model_usage_since_last_result: { main: counters(1, 1, 1.25), aux: counters(1, 1, 0.25) } }, 3), 1.5)
  assert.equal(claudeTurnCost({}, 3), 0)
})

test('other CLIs give one row for the session model, and empty turns none', () => {
  const state = { model: 'gpt-6-astra', claude: null }
  assert.deepEqual(turnUsageOf('codex', completed(5, 7, 11, 13), { turn: {} }, state).rows, [
    { model: 'gpt-6-astra', inputTokens: 5, outputTokens: 7, cacheReadTokens: 11, cacheWriteTokens: 13, cacheWrite1hTokens: 0, reportedCostUsd: null },
  ])
  assert.equal(turnUsageOf('grok', completed(5, 7, 0, 0, 0.02), null, state).rows[0]?.reportedCostUsd, 0.02)
  assert.deepEqual(turnUsageOf('codex', completed(0, 0), null, state).rows, [])
  // Copilot's Auto session says `auto`; the turn names the model it was routed to.
  assert.deepEqual(turnUsageOf('copilot', { ...completed(5, 7), model: 'gpt-6-luna', aiCredits: 0.17 }, null, { model: 'auto', claude: null }).rows.map((row) => row.model), ['gpt-6-luna'])
  // A Claude turn without its result: tokens from the journal, and no trust in its cost.
  assert.deepEqual(turnUsageOf('claude', completed(5, 7, 0, 0, 40), null, { model: null, claude: null }).rows, [
    { model: '', inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reportedCostUsd: null },
  ])
})

test('turns are recorded as they complete, with the owner read at that moment', (t) => {
  const db = database(t)
  conversation(db, 'c', 'codex', { model: 'gpt-6-astra' })
  const recorder = new TurnUsageRecorder(db)
  recorder.observe('c', { seq: 1, ts: 100, event: { type: 'message.delta', messageId: 'm', text: 'x' } as SillageEvent }, undefined)
  recorder.observe('c', { seq: 2, ts: 200, event: completed(5, 7) }, undefined)
  recorder.observe('c', { seq: 3, ts: 300, event: { type: 'session.started', agent: 'codex', agentSessionId: 's', model: 'gpt-6-sol', cwd: '/', tools: [] } as SillageEvent }, undefined)
  db.update(conversations).set({ projectId: null }).where(eq(conversations.id, 'c')).run()
  recorder.observe('c', { seq: 4, ts: 400, event: completed(1, 1) }, undefined)
  recorder.observe('c', { seq: 4, ts: 400, event: completed(1, 1) }, undefined)
  recorder.observe('gone', { seq: 1, ts: 1, event: completed(1, 1) }, undefined)
  assert.deepEqual(db.select().from(turnUsage).all().map((row) => [row.seq, row.model, row.projectId, row.userId, row.agent, row.inputTokens]), [
    [2, 'gpt-6-astra', 'p', 'alice', 'codex', 5],
    [4, 'gpt-6-sol', null, 'alice', 'codex', 1],
  ])
})

test('sub-agent consumption gets its own row, under its model or the session\'s', (t) => {
  const db = database(t)
  conversation(db, 'c', 'codex', { model: 'gpt-6-astra' })
  const recorder = new TurnUsageRecorder(db)
  const consumed = (model: string | null, inputTokens: number): SillageEvent =>
    ({ type: 'usage.consumed', model, costUsd: 0, inputTokens, outputTokens: 3, cacheReadTokens: 10, cacheCreationTokens: 0 })
  recorder.observe('c', { seq: 1, ts: 100, event: completed(5, 7) }, undefined)
  recorder.observe('c', { seq: 2, ts: 150, event: consumed('gpt-6-luna', 4) }, undefined)
  recorder.observe('c', { seq: 3, ts: 160, event: consumed(null, 2) }, undefined)
  recorder.observe('c', { seq: 4, ts: 170, event: { ...consumed(null, 0), outputTokens: 0, cacheReadTokens: 0 } as SillageEvent }, undefined)
  assert.deepEqual(db.select().from(turnUsage).orderBy(turnUsage.seq).all().map((row) => [row.seq, row.model, row.inputTokens, row.outputTokens, row.cacheReadTokens]), [
    [1, 'gpt-6-astra', 5, 7, 0],
    [2, 'gpt-6-luna', 4, 3, 10],
    [3, 'gpt-6-astra', 2, 3, 10],
  ])
  // Benchmarks fold the same events into a run's measures.
  const metrics = computeRunMetrics([
    { conversationId: 'c', seq: 1, ts: 100, event: completed(5, 7) },
    { conversationId: 'c', seq: 2, ts: 150, event: consumed('gpt-6-luna', 4) },
  ], 'codex')
  assert.deepEqual([metrics.inputTokens, metrics.outputTokens, metrics.cacheReadTokens], [5 + 4 + 10, 10, 10])
})

test('history is read once from the journals, forks do not count twice and Claude totals are repaired', async (t) => {
  const db = database(t)
  const log = new EventLog(db)
  conversation(db, 'source', 'claude', { createdAt: 1, costUsd: 99 })
  conversation(db, 'fork', 'claude', { createdAt: 2, costUsd: 99 })
  conversation(db, 'codex', 'codex', { createdAt: 3, model: 'fallback-model', costUsd: 7 })
  log.appendBatch('source', [
    { ts: 10, event: { type: 'session.started', agent: 'claude', agentSessionId: 's', model: 'main', cwd: '/', tools: [] } as SillageEvent },
    { ts: 20, event: completed(1, 1, 0, 0, 1), raw: { type: 'result', total_cost_usd: 1, modelUsage: { main: counters(10, 20, 1) } } },
    { ts: 30, event: completed(1, 1, 0, 0, 3), raw: { type: 'result', total_cost_usd: 3, modelUsage: { main: counters(30, 60, 3) } } },
  ])
  log.copyThrough('source', 'fork', 3)
  log.appendBatch('fork', [{ ts: 40, event: completed(1, 1, 0, 0, 0.5), raw: { type: 'result', total_cost_usd: 0.5, modelUsage: { main: counters(4, 5, 0.5) } } }])
  log.appendBatch('codex', [{ ts: 50, event: completed(8, 9) }, { ts: 60, event: completed(0, 0) },
    { ts: 70, event: { type: 'usage.consumed', model: 'gpt-6-luna', costUsd: 0, inputTokens: 6, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 } }])

  const recorder = new TurnUsageRecorder(db)
  assert.equal(recorder.historyReady(), false)
  // A turn completing while the journals are being read is not written twice.
  recorder.observe('codex', { seq: 1, ts: 50, event: completed(8, 9) }, undefined)
  await Promise.all([recorder.importHistory(), recorder.importHistory()])
  assert.equal(recorder.historyReady(), true)
  assert.deepEqual(db.select().from(turnUsage).orderBy(turnUsage.ts).all().map((row) => [row.conversationId, row.seq, row.model, row.inputTokens, row.outputTokens, row.reportedCostUsd]), [
    ['source', 2, 'main', 10, 20, 1],
    ['source', 3, 'main', 20, 40, 2],
    ['fork', 4, 'main', 4, 5, 0.5],
    ['codex', 1, 'fallback-model', 8, 9, null],
    ['codex', 3, 'gpt-6-luna', 6, 2, null],
  ])
  const costs = Object.fromEntries(db.select({ id: conversations.id, costUsd: conversations.costUsd }).from(conversations).all().map((row) => [row.id, row.costUsd]))
  assert.deepEqual(costs, { source: 3, fork: 0.5, codex: 7 })

  // Done once: later starts leave the table alone.
  db.delete(turnUsage).run()
  await new TurnUsageRecorder(db).importHistory()
  assert.equal(db.select().from(turnUsage).all().length, 0)
})

// Payloads probed on antigravity-acp 1.4.3 and 1.5.2 (27 Nov 2026).
const gross143 = { totalTokens: 60128, inputTokens: 58538, outputTokens: 274, thoughtTokens: 1316, cachedReadTokens: 37124, cachedWriteTokens: 0 }
const net152 = { totalTokens: 226295, inputTokens: 43648, outputTokens: 4751, thoughtTokens: 3953, cachedReadTokens: 177896, cachedWriteTokens: 0 }

test('Antigravity usage is read in its 1.4 form (cache inside the input) and its 1.5 form (reasoning inside the output)', () => {
  assert.deepEqual(antigravityTurnTokens(gross143), { inputTokens: 21414, outputTokens: 1590, cacheReadTokens: 37124, cacheCreationTokens: 0 })
  assert.deepEqual(antigravityTurnTokens(net152), { inputTokens: 43648, outputTokens: 4751, cacheReadTokens: 177896, cacheCreationTokens: 0 })
  // Reasoning equal to the cache read makes both sums agree: the counters decide, then the
  // targeted release's net form.
  assert.deepEqual(antigravityTurnTokens({ totalTokens: 1110, inputTokens: 1000, outputTokens: 10, thoughtTokens: 100, cachedReadTokens: 100 }), { inputTokens: 900, outputTokens: 110, cacheReadTokens: 100, cacheCreationTokens: 0 })
  assert.deepEqual(antigravityTurnTokens({ totalTokens: 1200, inputTokens: 1000, outputTokens: 100, thoughtTokens: 100, cachedReadTokens: 100 }), { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 100, cacheCreationTokens: 0 })
  // Without a total, a cache larger than the input can only be net of it.
  assert.deepEqual(antigravityTurnTokens({ inputTokens: 40, outputTokens: 5, thoughtTokens: 2, cachedReadTokens: 900 }), { inputTokens: 40, outputTokens: 5, cacheReadTokens: 900, cacheCreationTokens: 0 })
  assert.deepEqual(antigravityTurnTokens({}), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })
})

test('Antigravity turns journaled with the cache inside their input are repaired once, with what derives from them', async (t) => {
  const db = database(t)
  const log = new EventLog(db)
  // Totals as the old runner summed them: inputs include the cache read, outputs the reasoning.
  conversation(db, 'ag', 'antigravity', { createdAt: 1, model: 'gemini-test', inputTokens: 58538 + 43648, outputTokens: 1590 + 4751 })
  log.appendBatch('ag', [
    { ts: 10, event: { type: 'session.started', agent: 'antigravity', agentSessionId: 's', model: 'gemini-test', cwd: '/', tools: [] } as SillageEvent },
    { ts: 20, event: completed(58538, 1590, 37124), raw: { stopReason: 'end_turn', usage: gross143 } },
    // Already right: left as it is.
    { ts: 30, event: completed(43648, 4751, 177896), raw: { stopReason: 'end_turn', usage: net152 } },
  ])
  // Live recording had already written the inflated row.
  new TurnUsageRecorder(db).observe('ag', { seq: 2, ts: 20, event: completed(58538, 1590, 37124) }, undefined)
  db.insert(benchmarks).values({ id: 'b', userId: 'alice', name: 'b', prompt: 'p', variants: '[]', maxDurationMinutes: 10, createdAt: 1, updatedAt: 1 }).run()
  db.insert(benchmarkRuns).values({ id: 'r', benchmarkId: 'b', variantId: 'v', conversationId: 'ag', repetition: 1, status: 'succeeded', finishedAt: 40, metrics: JSON.stringify({ version: 3, inputTokens: 1 }) }).run()

  await new TurnUsageRecorder(db).importHistory()
  assert.deepEqual(db.select().from(turnUsage).orderBy(turnUsage.seq).all().map((row) => [row.seq, row.inputTokens, row.outputTokens, row.cacheReadTokens]), [
    [2, 21414, 1590, 37124],
    [3, 43648, 4751, 177896],
  ])
  const journaled = db.select({ payload: events.payload }).from(events).where(eq(events.seq, 2)).get()!
  assert.deepEqual(JSON.parse(journaled.payload), completed(21414, 1590, 37124))
  const totals = db.select({ input: conversations.inputTokens, output: conversations.outputTokens }).from(conversations).where(eq(conversations.id, 'ag')).get()
  assert.deepEqual(totals, { input: 21414 + 43648, output: 1590 + 4751 })
  // The benchmark run folds its journal again at its next read.
  assert.equal(JSON.parse(db.select({ metrics: benchmarkRuns.metrics }).from(benchmarkRuns).get()!.metrics!).version, 0)
})

test('Claude token totals are rebuilt once from every model of their turns, never lowered', async (t) => {
  const db = database(t)
  const log = new EventLog(db)
  // Stored totals counted the main loop only; `delegating` also ran a sub-agent model.
  conversation(db, 'delegating', 'claude', { createdAt: 1, inputTokens: 4, outputTokens: 76 })
  // A journal shortened since its turns were counted keeps the larger stored total.
  conversation(db, 'trimmed', 'claude', { createdAt: 2, inputTokens: 500, outputTokens: 50 })
  conversation(db, 'codex', 'codex', { createdAt: 3, inputTokens: 1, outputTokens: 1 })
  log.appendBatch('delegating', [{ ts: 10, event: completed(4, 76), raw: { type: 'result', total_cost_usd: 0.05, model_usage_since_last_result: { main: counters(4, 76, 0.01), sub: counters(1200, 300, 0.04) } } }])
  log.appendBatch('trimmed', [{ ts: 20, event: completed(5, 5), raw: { type: 'result', model_usage_since_last_result: { main: counters(5, 5, 0.01) } } }])
  log.appendBatch('codex', [{ ts: 30, event: completed(8, 9) }])

  await new TurnUsageRecorder(db).importHistory()
  const totals = Object.fromEntries(db.select({ id: conversations.id, input: conversations.inputTokens, output: conversations.outputTokens }).from(conversations).all()
    .map((row) => [row.id, [row.input, row.output]]))
  assert.deepEqual(totals, { delegating: [1204, 376], trimmed: [500, 50], codex: [1, 1] })

  // Once: later turns are counted whole as they complete, a second pass would find nothing to add.
  db.update(conversations).set({ inputTokens: 0 }).where(eq(conversations.id, 'delegating')).run()
  await new TurnUsageRecorder(db).importHistory()
  assert.equal(db.select({ input: conversations.inputTokens }).from(conversations).where(eq(conversations.id, 'delegating')).get()?.input, 0)
})

test('Antigravity sub-agents are read back once from their transcripts, under the invoke_subagent that started them', async (t) => {
  const db = database(t)
  const log = new EventLog(db)
  const root = await mkdtemp(join(tmpdir(), 'sillage-antigravity-homes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const homes = { accounts: join(root, 'accounts'), user: join(root, 'default') }
  const brain = join(homes.accounts, 'acct', 'sillage-sessions', 'agh', 'antigravity-acp', 'brain')
  const transcript = async (id: string, steps: Record<string, unknown>[]) => {
    await mkdir(join(brain, id, '.system_generated', 'logs'), { recursive: true })
    await writeFile(join(brain, id, '.system_generated', 'logs', 'transcript_full.jsonl'), steps.map((step) => JSON.stringify(step) + '\n').join(''))
  }
  const planner = (step_index: number, created_at: string, input_tokens: number, cache_read_tokens: number, output_tokens: number) => ({ step_index, type: 'PLANNER_RESPONSE', created_at, input_tokens, cache_read_tokens, output_tokens })
  const invoke = (step_index: number, created_at: string, ...ids: string[]) => ({ step_index, type: 'INVOKE_SUBAGENT', created_at, content: ids.map((id) => `{ "conversationId":  "${id}" }`).join('\n') })
  // Production order: step indexes on disk are not sorted, and the tool id's suffix is not the step's.
  await transcript('main', [invoke(20, '2026-10-30T13:55:43Z', 'a', 'b'), planner(1, '2026-10-30T13:55:00Z', 9, 9, 9)])
  await transcript('a', [planner(1, '2026-10-30T13:55:50Z', 100, 1000, 10), planner(2, '2099-01-01T00:00:00Z', 5, 5, 5)])
  await transcript('b', [planner(1, '2026-10-30T13:56:00Z', 200, 2000, 20), invoke(2, '2026-10-30T13:56:01Z', 'c')])
  await transcript('c', [planner(1, '2026-10-30T13:56:05Z', 1, 2, 3)])
  conversation(db, 'agh', 'antigravity', { createdAt: 1, model: 'gemini-test', agentSessionId: 'main', config: JSON.stringify({ account: 'acct' }), inputTokens: 50, outputTokens: 5 })
  const tool = (ts: number, toolCallId: string) => ({ ts, event: { type: 'tool.started', toolCallId, name: 'invoke_subagent', input: {}, title: 'Running invoke_subagent', parentToolCallId: null } as SillageEvent })
  log.appendBatch('agh', [tool(Date.parse('2026-10-30T13:50:00Z'), 'main:3'), tool(Date.parse('2026-10-30T13:55:43.622Z'), 'main:15'), { ts: Date.parse('2026-10-30T13:57:00Z'), event: completed(50, 5) }])

  const recorder = new TurnUsageRecorder(db, join(root, 'codex'), homes)
  await recorder.importHistory()
  assert.deepEqual(db.select().from(turnUsage).orderBy(turnUsage.seq).all().map((row) => [row.seq, row.model, row.inputTokens, row.outputTokens, row.cacheReadTokens]), [
    [2, 'gemini-test', 301, 33, 3002],
    [3, 'gemini-test', 50, 5, 0],
  ])
  const totals = db.select({ input: conversations.inputTokens, output: conversations.outputTokens }).from(conversations).where(eq(conversations.id, 'agh')).get()
  assert.deepEqual(totals, { input: 50 + 301, output: 5 + 33 })
  db.delete(turnUsage).run()
  await new TurnUsageRecorder(db, join(root, 'codex'), homes).importHistory()
  assert.equal(db.select().from(turnUsage).all().length, 0)
})

test('Codex sub-agents are read back once from their rollouts, before live recording took over', async (t) => {
  const db = database(t)
  const log = new EventLog(db)
  const home = await mkdtemp(join(tmpdir(), 'sillage-codex-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const child = '01a1f43d-2e10-76f0-b392-7687d898e2f3'
  const now = Date.now()
  const iso = (ms: number) => new Date(ms).toISOString()
  const count = (at: number, input: number, cached: number, output: number) => JSON.stringify({ timestamp: iso(at), type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output } } } })
  await mkdir(join(home, 'sessions', '2026', '11', '19'), { recursive: true })
  await writeFile(join(home, 'sessions', '2026', '11', '19', `rollout-2026-11-19T15-36-49-${child}.jsonl`), [
    JSON.stringify({ timestamp: iso(now - 5000), type: 'turn_context', payload: { model: 'gpt-6-luna' } }),
    count(now - 4000, 1000, 600, 20),
    JSON.stringify({ timestamp: iso(now - 3500), type: 'response_item', payload: { type: 'message', content: 'token_count is mentioned here' } }),
    count(now - 3000, 2500, 1800, 45),
    // Written after this start: a live runner reports it as usage.consumed.
    count(now + 60_000, 9000, 8000, 90),
  ].join('\n'))
  conversation(db, 'source', 'codex', { createdAt: 1, model: 'gpt-6-astra', inputTokens: 10, outputTokens: 1 })
  conversation(db, 'fork', 'codex', { createdAt: 2, model: 'gpt-6-astra' })
  const spawned = (thread: string): SillageEvent => ({ type: 'tool.started', toolCallId: `codex-agent-${thread}-${crypto.randomUUID()}`, name: 'Agent', input: {}, parentToolCallId: null })
  log.appendBatch('source', [{ ts: 10, event: completed(1, 1) }, { ts: 20, event: spawned(child) }, { ts: 30, event: spawned(child) }, { ts: 40, event: spawned('01a1f43d-0000-7000-8000-000000000000') }])
  log.copyThrough('source', 'fork', 4)

  await new TurnUsageRecorder(db, home).importHistory()
  const rows = db.select().from(turnUsage).where(eq(turnUsage.model, 'gpt-6-luna')).all()
  assert.deepEqual(rows.map((row) => [row.conversationId, row.seq, row.inputTokens, row.cacheReadTokens, row.outputTokens, row.ts]), [
    ['source', 2, 700, 1800, 45, now - 3000],
  ])
  const totals = db.select({ inputTokens: conversations.inputTokens, outputTokens: conversations.outputTokens }).from(conversations).where(eq(conversations.id, 'source')).get()
  assert.deepEqual(totals, { inputTokens: 710, outputTokens: 46 })
})

test('the report prices groups, buckets them on the reader\'s calendar and names what remains', (t) => {
  const db = database(t)
  const prices = catalog(db)
  const base = { userId: 'alice', projectId: 'p', agent: 'claude' as const, seq: 1 }
  const at = (iso: string) => Date.parse(iso)
  db.insert(turnUsage).values([
    // 23:30 in Paris on the 1st, already the 2nd in UTC.
    { ...base, conversationId: 'a', model: 'claude-opus-5-5', ts: at('2026-11-01T22:30:00Z'), inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 100_000, cacheWrite1hTokens: 100_000 },
    { ...base, conversationId: 'a', model: 'mystery-model', ts: at('2026-11-01T22:30:00Z'), inputTokens: 500, outputTokens: 500 },
    { ...base, conversationId: 'b', seq: 2, agent: 'codex' as const, model: 'gpt-6-astra', ts: at('2026-11-03T10:00:00Z'), userId: 'admin', projectId: null, inputTokens: 100_000, outputTokens: 10_000 },
    { ...base, conversationId: 'gone', agent: 'codex' as const, model: 'gpt-6-astra', ts: at('2026-11-03T11:00:00Z'), userId: 'left', projectId: 'deleted', inputTokens: 100_000, outputTokens: 0 },
    { ...base, conversationId: 'old', model: 'claude-opus-5-5', ts: at('2026-10-01T10:00:00Z'), inputTokens: 1, outputTokens: 1 },
  ]).run()
  conversation(db, 'a', 'claude', { title: 'Costly' })
  conversation(db, 'b', 'codex', { title: 'Cheap', projectId: null })

  const range = { from: at('2026-10-31T23:00:00Z'), to: at('2026-11-04T23:00:00Z'), timeZone: 'Europe/Paris' }
  const report = consumptionReport(db, prices, range, true)
  const opus = prices.priceOf('claude-opus-5-5')!
  const astra = prices.priceOf('gpt-6-astra')!
  const opusCost = costOf(opus, { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 100_000, cacheWrite1hTokens: 100_000 })
  const astraCost = (200_000 * astra.input + 10_000 * astra.output) / 1e6
  const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`)

  assert.equal(report.bucket, 'day')
  assert.deepEqual(report.series.map((entry) => entry.date), ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'])
  assert.deepEqual(report.series.map((entry) => entry.agents.map((amount) => amount.agent)), [['claude'], [], ['codex'], []])
  near(report.total.costUsd, opusCost + astraCost)
  assert.equal(report.total.inputTokens, 1_200_500)
  assert.equal(report.total.cacheWriteTokens, 200_000)
  assert.equal(report.sessions, 3)
  assert.deepEqual(report.agents.map((row) => row.agent), ['claude', 'codex'])
  assert.deepEqual(report.models.map((row) => [row.model, row.price !== null]), [['claude-opus-5-5', true], ['gpt-6-astra', true], ['mystery-model', false]])
  assert.equal(report.models[2]?.costUsd, 0)
  assert.deepEqual(report.projects.map((row) => [row.projectId, row.name]), [['p', 'Project'], [null, null], ['deleted', null]])
  assert.deepEqual(report.accounts.map((row) => [row.userId, row.name]), [['alice', 'ALICE'], ['admin', 'ADMIN'], ['left', null]])
  assert.deepEqual(report.conversations.map((row) => [row.conversationId, row.title, row.agent]), [['a', 'Costly', 'claude'], ['b', 'Cheap', 'codex'], ['gone', null, 'codex']])
  assert.equal(report.prices.origin, 'bundled')

  // No start asked: from the first recorded turn, by month once the range is long.
  const all = consumptionReport(db, prices, { from: null, to: at('2027-03-10T00:00:00Z'), timeZone: 'UTC' }, false)
  assert.equal(all.from, at('2026-10-01T10:00:00Z'))
  assert.equal(all.bucket, 'month')
  assert.deepEqual(all.series.map((entry) => entry.date), ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'])
  assert.equal(all.historyReady, false)
  // Nothing recorded at all: an empty range rather than a bucket per day since 1970.
  db.delete(turnUsage).run()
  assert.deepEqual(consumptionReport(db, prices, { from: null, to: 5, timeZone: 'UTC' }, true).series, [])
})

test('the catalog ships prices, adopts fetched lists and keeps them through failures', async (t) => {
  const db = database(t)
  let now = 1_000
  const shipped = catalog(db)
  assert.equal(shipped.status().origin, 'bundled')
  assert.ok(shipped.priceOf('claude-opus-5-5'), 'the shipped list prices a current model')
  await shipped.refresh()
  assert.deepEqual([shipped.status().error, shipped.status().origin], ['network', 'bundled'])

  const pad = (table: Record<string, unknown>, entry: unknown) => ({ ...Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`pad-${index}`, entry])), ...table })
  const lists = {
    [PRICE_SOURCES[0].url]: pad(litellm, litellm['gpt-6-astra']),
    [PRICE_SOURCES[1].url]: { opencode: { models: pad(modelsDev.opencode.models, { cost: { input: 1, output: 1 } }) } },
  }
  let calls = 0
  const online = catalog(db, async (url, init) => { calls++; return answers(lists)(url, init) }, () => now)
  await Promise.all([online.refresh(), online.refresh()])
  assert.equal(calls, 2, 'concurrent refreshes share one pass over the sources')
  assert.deepEqual(online.status(), { updatedAt: 1_000, checkedAt: 1_000, origin: 'online', error: null })
  assert.equal(online.priceOf('claude-opus-5-5')?.input, 4)
  assert.equal(online.priceOf('opencode/glm-5.2')?.input, 1.4)

  // Unchanged upstream: checked again, prices not dated again.
  now = 2_000
  await online.refresh()
  assert.deepEqual(online.status(), { updatedAt: 1_000, checkedAt: 2_000, origin: 'online', error: null })

  // A truncated list or a dead network leaves the last good prices, across a restart too.
  now = 3_000
  const broken = catalog(db, answers({ [PRICE_SOURCES[0].url]: { 'gpt-6-astra': litellm['gpt-6-astra'] }, [PRICE_SOURCES[1].url]: {} }, '"v2"'), () => now)
  assert.equal(broken.status().origin, 'online')
  await broken.refresh()
  assert.deepEqual(broken.status(), { updatedAt: 1_000, checkedAt: 2_000, origin: 'online', error: 'invalid' })
  assert.equal(broken.priceOf('claude-opus-5-5')?.input, 4)

  // New prices upstream move the date.
  const raised = { ...lists, [PRICE_SOURCES[0].url]: pad({ ...litellm, 'claude-opus-5-5': { ...litellm['claude-opus-5-5'], input_cost_per_token: 6e-6 } }, litellm['gpt-6-astra']) }
  const updated = catalog(db, answers(raised, '"v3"'), () => now)
  await updated.refresh()
  assert.deepEqual(updated.status(), { updatedAt: 3_000, checkedAt: 3_000, origin: 'online', error: null })
  assert.equal(updated.priceOf('claude-opus-5-5')?.input, 6)
})

test('every account reads the instance consumption, only an admin asks for the prices again', async (t) => {
  const db = database(t)
  let calls = 0
  const prices = catalog(db, async () => { calls++; throw new Error('offline') })
  const recorder = new TurnUsageRecorder(db)
  db.insert(turnUsage).values({ conversationId: 'c', seq: 1, model: 'claude-opus-5-5', ts: 1_000, userId: 'alice', projectId: 'p', agent: 'claude', inputTokens: 1_000_000 }).run()
  const app = Fastify()
  registerErrorHandler(app)
  app.addHook('preHandler', async (request) => {
    const id = request.headers['x-user']
    if (typeof id === 'string') request.user = db.select().from(users).where(eq(users.id, id)).get()
  })
  registerConsumptionRoutes(app, { db } as AppContext, prices, recorder)
  t.after(() => app.close())

  assert.equal((await app.inject({ url: '/api/consumption' })).statusCode, 401)
  for (const user of ['alice', 'admin']) {
    const response = await app.inject({ url: '/api/consumption?from=0&to=2000&tz=Europe/Paris', headers: { 'x-user': user } })
    assert.equal(response.statusCode, 200)
    const report = response.json() as ConsumptionReport
    assert.equal(report.total.inputTokens, 1_000_000)
    assert.equal(report.historyReady, false)
  }
  assert.equal((await app.inject({ url: '/api/consumption?tz=Mars/Olympus', headers: { 'x-user': 'alice' } })).statusCode, 400)
  assert.equal((await app.inject({ method: 'POST', url: '/api/consumption/prices/refresh', headers: { 'x-user': 'alice' } })).statusCode, 403)
  assert.equal(calls, 0)
  const refreshed = await app.inject({ method: 'POST', url: '/api/consumption/prices/refresh', headers: { 'x-user': 'admin' } })
  assert.equal(refreshed.statusCode, 200)
  assert.equal(refreshed.json().error, 'network')
  assert.equal(calls, 2)
})

test('a benchmark run is priced like the dashboard: its recorded turns up to settlement, else its stored totals', (t) => {
  const db = database(t)
  const prices = catalog(db)
  const opus = prices.priceOf('claude-opus-5-5')!
  const haiku = prices.priceOf('claude-haiku-5-5')!
  const stored = { ...computeRunMetrics([]), model: 'claude-opus-5-5', inputTokens: 3_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_500_000, cacheCreationTokens: 500_000, costUsd: 999 }
  const base = { userId: 'alice', projectId: null, agent: 'claude' as const }
  db.insert(turnUsage).values([
    { ...base, conversationId: 'run', seq: 1, model: 'claude-opus-5-5', ts: 100, inputTokens: 1_000_000, cacheWrite1hTokens: 1_000_000 },
    { ...base, conversationId: 'run', seq: 1, model: 'claude-haiku-5-5', ts: 100, outputTokens: 1_000_000 },
    { ...base, conversationId: 'run', seq: 2, model: 'claude-opus-5-5', ts: 200, inputTokens: 1_000_000 },
    // The discussion went on after the run settled: not the benchmark's.
    { ...base, conversationId: 'run', seq: 3, model: 'claude-opus-5-5', ts: 900, inputTokens: 50_000_000 },
    { ...base, conversationId: 'odd', seq: 1, model: 'claude-opus-5-5', ts: 100, inputTokens: 1_000_000 },
    { ...base, conversationId: 'odd', seq: 1, model: 'mystery-model', ts: 100, inputTokens: 1_000_000 },
  ]).run()

  assert.equal(runCostUsd(db, prices, { conversationId: 'run', finishedAt: 500 }, stored), 2 * opus.input + opus.cacheWrite1h! + haiku.output)
  // One model without a public price: no partial figure to rank a variant on.
  assert.equal(runCostUsd(db, prices, { conversationId: 'odd', finishedAt: 500 }, stored), null)
  // Turns never recorded: the stored totals, the cache taken out of the input it is counted in.
  const fallback = opus.input + opus.output + 1.5 * opus.cacheRead! + 0.5 * opus.cacheWrite!
  assert.equal(runCostUsd(db, prices, { conversationId: null, finishedAt: 500 }, stored), fallback)
  assert.equal(runCostUsd(db, prices, { conversationId: 'never-recorded', finishedAt: 500 }, stored), fallback)
  assert.equal(runCostUsd(db, prices, { conversationId: null, finishedAt: 500 }, { ...stored, model: null }), null)
  assert.equal(runCostUsd(db, prices, { conversationId: null, finishedAt: 500 }, { ...stored, inputTokens: null }), null)
})

test('a conversation\'s details count distinct tool calls and price its turns, behind the read check', async (t) => {
  const db = database(t)
  const prices = catalog(db)
  const opus = prices.priceOf('claude-opus-5-5')!
  conversation(db, 'c', 'claude')
  db.insert(projects).values({ id: 'secret', name: 'Secret', workspacePath: '/tmp', ownerId: 'admin', visibility: 'private', createdAt: 1 }).run()
  conversation(db, 'hidden', 'claude', { projectId: 'secret', userId: 'admin' })
  const log = new EventLog(db)
  const started = (toolCallId: string, name: string, parentToolCallId: string | null = null): SillageEvent => ({ type: 'tool.started', toolCallId, name, input: {}, parentToolCallId })
  const done = (toolCallId: string, isError: boolean): SillageEvent => ({ type: 'tool.completed', toolCallId, output: '', isError, durationMs: 1 })
  for (const event of [
    started('1', 'Bash'), started('2', 'Bash'), started('3', 'Read'), started('4', 'Bash', 'agent'),
    // Resynchronization can journal a call twice: it is still one call.
    started('1', 'Bash'), done('1', true), done('1', true), done('2', false),
  ]) log.append('c', event)
  db.insert(turnUsage).values({ conversationId: 'c', seq: 1, model: 'claude-opus-5-5', ts: 1, userId: 'alice', projectId: 'p', agent: 'claude', inputTokens: 1_000_000, cacheReadTokens: 10 }).run()

  const app = Fastify()
  registerErrorHandler(app)
  app.addHook('preHandler', async (request) => {
    const id = request.headers['x-user']
    if (typeof id === 'string') request.user = db.select().from(users).where(eq(users.id, id)).get()
  })
  registerConsumptionRoutes(app, { db } as AppContext, prices, new TurnUsageRecorder(db))
  t.after(() => app.close())

  const response = await app.inject({ url: '/api/conversations/c/stats', headers: { 'x-user': 'alice' } })
  assert.equal(response.statusCode, 200)
  const stats = response.json() as ConversationStatsDto
  assert.equal(stats.toolCalls, 4)
  assert.equal(stats.toolErrors, 1)
  assert.deepEqual(stats.tools, [{ name: 'Bash', count: 3 }, { name: 'Read', count: 1 }])
  assert.equal(stats.costUsd, opus.input + 10 * opus.cacheRead! / 1e6)
  assert.deepEqual(stats.tokens, { input: 1_000_000, output: 0, cacheRead: 10, cacheWrite: 0 })
  assert.equal((await app.inject({ url: '/api/conversations/hidden/stats', headers: { 'x-user': 'alice' } })).statusCode, 404)
  const empty = (await app.inject({ url: '/api/conversations/hidden/stats', headers: { 'x-user': 'admin' } })).json() as ConversationStatsDto
  assert.equal(empty.costUsd, null)
  assert.equal(empty.toolCalls, 0)
})
