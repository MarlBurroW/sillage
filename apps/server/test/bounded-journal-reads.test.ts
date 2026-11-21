import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq, sql } from 'drizzle-orm'
import Fastify from 'fastify'
import { conversations, events, openDatabase, projects, runMigrations, users } from '@sillage/db'
import { DEFAULT_CONFIGS, type SillageEvent } from '@sillage/protocol'
import { bearerSecret, createApiToken, resolveApiToken } from '../src/auth/api-tokens.js'
import { collectHandoffItems, readHandoffItems } from '../src/conversations/handoff.js'
import { EventLog } from '../src/events/event-log.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerV1Routes } from '../src/http/v1/index.js'
import type { AgentRegistry } from '../src/agents/registry.js'
import type { Config } from '../src/config.js'
import type { SessionManager } from '../src/sessions/session-manager.js'
import type { WebhookService } from '../src/webhooks/service.js'

/** Journal readers that must not pull a whole conversation into the daemon heap: fork copy, handoff, public task events. */

const user = (messageId: string, text: string): SillageEvent =>
  ({ type: 'message.completed', messageId, role: 'user', blocks: [{ type: 'text', text }], parentToolCallId: null })
const said = (messageId: string, text: string): SillageEvent =>
  ({ type: 'message.completed', messageId, role: 'assistant', blocks: [{ type: 'text', text }], parentToolCallId: null })
const bash = (toolCallId: string, command: string): SillageEvent =>
  ({ type: 'tool.started', toolCallId, name: 'Bash', input: { command }, parentToolCallId: null })
const delta = (toolCallId: string, text: string): SillageEvent =>
  ({ type: 'tool.output_delta', toolCallId, chunk: text })
const done = (toolCallId: string, output: unknown): SillageEvent =>
  ({ type: 'tool.completed', toolCallId, output, isError: false, durationMs: 5 })
const turnEnd = (stopReason: string): SillageEvent => ({
  type: 'turn.completed', stopReason, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
} as SillageEvent)

async function database(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-bounded-reads-'))
  const file = join(dir, 'test.db')
  const { db, sqlite } = openDatabase(file)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(async () => { sqlite.close(); await rm(dir, { recursive: true, force: true }) })
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'Owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'Project', workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const conversation = (id: string) => db.insert(conversations).values({
    id, projectId: 'project', userId: 'owner', title: id, agent: 'claude', config: JSON.stringify(DEFAULT_CONFIGS.claude), status: 'idle',
    createdAt: 1, updatedAt: 1,
  }).run()
  return { db, dir, file, conversation, log: new EventLog(db) }
}

const JOURNAL: SillageEvent[] = [
  user('u1', 'Corrige le cache, s’il te plaît 🚀'),
  bash('t1', 'npm test'),
  delta('t1', 'running…'),
  done('t1', 'ok'),
  said('a1', 'Les tests passent.'),
  turnEnd('end_turn'),
  user('u2', 'Et la doc ?'),
  said('a2', 'Mise à jour.'),
  turnEnd('interrupted'),
]

test('a fork copies its prefix inside SQLite, renumbered, with raw, bytes, turns and search', async (t) => {
  const { db, conversation, log } = await database(t)
  conversation('source')
  conversation('fork')
  log.appendBatch('source', JOURNAL.map((event, index) => ({ ts: index + 1, event, raw: { native: index, text: 'é'.repeat(index) } })))

  assert.equal(log.copyThrough('source', 'fork', 9), 9)
  const source = db.select().from(conversations).where(eq(conversations.id, 'source')).get()!
  const fork = db.select().from(conversations).where(eq(conversations.id, 'fork')).get()!
  assert.equal(fork.lastSeq, 9)
  // Same UTF-8 weight as `append` computes in JavaScript, accents and emoji included.
  assert.equal(fork.journalBytes, source.journalBytes)
  assert.equal(fork.turnCount, 2)

  const copied = db.select().from(events).where(eq(events.conversationId, 'fork')).all()
  assert.deepEqual(copied.map((row) => row.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.deepEqual(JSON.parse(copied[4]!.raw!), { native: 4, text: 'éééé' })
  const indexed = db.get<{ count: number }>(sql`SELECT count(*) AS count FROM search_messages WHERE conversation_id = 'fork'`)
  assert.ok((indexed?.count ?? 0) > 0)

  // A partial fork stops at its cut point and keeps counting turns of that prefix only.
  conversation('partial')
  assert.equal(log.copyThrough('source', 'partial', 6), 6)
  const partial = db.select().from(conversations).where(eq(conversations.id, 'partial')).get()!
  assert.equal(partial.lastSeq, 6)
  assert.equal(partial.turnCount, 1)
})

test('handoff items are folded page by page, filtered to the types they use', async (t) => {
  const { conversation, log } = await database(t)
  conversation('c')
  log.appendBatch('c', JOURNAL.map((event, index) => ({ ts: index + 1, event })))

  const everything = log.readForReplay('c', 0, { rows: 1000, bytes: 1 << 24 }).entries
  assert.deepEqual(readHandoffItems(log, 'c'), collectHandoffItems(everything))
  assert.deepEqual(readHandoffItems(log, 'c', 5), collectHandoffItems(everything.filter((entry) => entry.seq <= 5)))
})

test('readForReplay can serve stored payloads, exclude types and say when bytes cut a page', async (t) => {
  const { conversation, log } = await database(t)
  conversation('c')
  const big = 'x'.repeat(20_000)
  log.appendBatch('c', [bash('t1', 'cat big'), delta('t1', 'chunk'), done('t1', big), said('a1', 'fini')].map((event, index) => ({ ts: index + 1, event })))

  const stored = log.readForReplay('c', 0, { rows: 10, bytes: 1 << 20, stored: true, unfiltered: true, exceptTypes: ['tool.output_delta'] })
  assert.deepEqual(stored.entries.map((entry) => entry.event.type), ['tool.started', 'tool.completed', 'message.completed'])
  const completed = stored.entries[1]!.event
  assert.equal(completed.type === 'tool.completed' ? completed.output : null, big, 'complete output, not the replay preview')
  assert.equal(stored.cut, false)

  const cut = log.readForReplay('c', 0, { rows: 10, bytes: 1000, stored: true, unfiltered: true })
  assert.equal(cut.cut, true)
  assert.deepEqual(cut.entries.map((entry) => entry.seq), [1, 2])
})

test('public task events page in bytes, filter in SQL and never loop on a filtered cursor', async (t) => {
  const { db, conversation, log } = await database(t)
  conversation('task')
  const { secret } = createApiToken(db, { userId: 'owner', label: 'Client', scopes: ['tasks:read'], projectIds: ['project'], agent: 'claude',
    config: DEFAULT_CONFIGS.claude, executionPolicy: null, expiresAt: null, webhookUrl: null })
  const big = 'y'.repeat(6 * 1024 * 1024)
  log.appendBatch('task', [
    bash('t1', 'one'), delta('t1', 'noise'), done('t1', big),
    bash('t2', 'two'), done('t2', big),
    bash('t3', 'three'), done('t3', big),
    said('a1', 'fini'),
  ].map((event, index) => ({ ts: index + 1, event })))

  const app = Fastify({ logger: { level: 'error' } })
  app.addHook('onRequest', async (request) => {
    const supplied = bearerSecret(request.headers.authorization)
    const identity = supplied ? resolveApiToken(db, supplied) : null
    if (identity) { request.user = identity.user; request.apiToken = identity.token }
  })
  registerErrorHandler(app)
  const ctx = { db, config: { server: { port: 7317, publicUrl: 'https://example.test' }, paths: {}, limits: { maxConcurrentSessions: 4 } } as unknown as Config }
  const sessions = { statusBus: new EventEmitter() } as unknown as SessionManager
  registerV1Routes(app, ctx, log, sessions, { all: () => [] } as unknown as AgentRegistry, {} as unknown as WebhookService)
  t.after(() => app.close())
  const page = async (query: string) => {
    const response = await app.inject({ url: `/api/v1/tasks/task/events?${query}`, headers: { authorization: `Bearer ${secret}` } })
    assert.equal(response.statusCode, 200, response.body)
    return response.json() as { events: { seq: number; event: SillageEvent }[]; nextAfter: number; hasMore: boolean }
  }

  // 16 MiB per page: three 6 MiB outputs cannot share one, and each stays complete.
  const first = await page('after=0')
  assert.deepEqual(first.events.map((entry) => entry.seq), [1, 3, 4, 5, 6])
  assert.equal(first.hasMore, true)
  const output = first.events[1]!.event
  assert.equal(output.type === 'tool.completed' ? (output.output as string).length : 0, big.length)
  const second = await page(`after=${first.nextAfter}`)
  assert.deepEqual(second.events.map((entry) => entry.seq), [7, 8])
  assert.equal(second.hasMore, false)

  // A filter that matches nothing after the cursor moves it to the end instead of leaving it in place.
  const messages = await page('after=0&types=message.completed')
  assert.deepEqual(messages.events.map((entry) => entry.seq), [8])
  const none = await page(`after=${messages.nextAfter}&types=message.completed`)
  assert.deepEqual(none.events, [])
  assert.equal(none.hasMore, false)
  assert.equal(none.nextAfter, 8)

  // The row limit still applies, with the extra entry telling whether more remain.
  const limited = await page('after=0&limit=2&types=tool.started')
  assert.deepEqual(limited.events.map((entry) => entry.seq), [1, 4])
  assert.equal(limited.hasMore, true)
  const rest = await page(`after=${limited.nextAfter}&limit=2&types=tool.started`)
  assert.deepEqual(rest.events.map((entry) => entry.seq), [6])
  assert.equal(rest.hasMore, false)
})
