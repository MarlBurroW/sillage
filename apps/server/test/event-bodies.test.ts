import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { conversations, openDatabase, projects, runMigrations, users } from '@sillage/db'
import type { ServerMessage, SillageEvent } from '@sillage/protocol'
import { EventLog } from '../src/events/event-log.js'
import { imageDimensions } from '../src/events/event-bodies.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerConversationRoutes } from '../src/http/routes/conversations.js'
import { registerWebSocketHub } from '../src/ws/hub.js'
import type { AppContext } from '../src/http/context.js'
import type { SessionManager } from '../src/sessions/session-manager.js'
import type { AgentRegistry } from '../src/agents/registry.js'
import type { AttachmentStore } from '../src/attachments/store.js'
import type { WebhookService } from '../src/webhooks/service.js'
import type { Notifications } from '../src/notifications/dispatcher.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAADElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const url = `data:image/png;base64,${png.toString('base64')}`
const huge = 'é'.repeat(100_000)
const input = { file_path: 'large.ts', description: 'Edit the file', content: huge }
const journal: SillageEvent[] = [
  { type: 'message.completed', messageId: 'm', role: 'assistant', parentToolCallId: null, blocks: [
    { type: 'text', text: 'A searchable message' }, { type: 'image', mimeType: 'image/png', url },
    { type: 'tool_use', toolCallId: 'tool', name: 'Write', input },
    { type: 'tool_result', toolCallId: 'tool', output: huge, isError: false },
  ] },
  { type: 'tool.started', toolCallId: 'tool', name: 'Write', input, parentToolCallId: null },
  { type: 'tool.input_updated', toolCallId: 'tool', input: { ...input, content: huge + 'updated' } },
  { type: 'tool.completed', toolCallId: 'tool', output: { text: huge }, isError: false, durationMs: 1 },
  { type: 'diff.updated', files: [{ path: 'large.ts', added: 1, removed: 0 }], patch: huge },
]

function fixture(t: TestContext) {
  const { db, sqlite } = openDatabase(':memory:')
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  for (const id of ['owner', 'reader']) db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'p', ownerId: 'owner', name: 'p', workspacePath: '/tmp', visibility: 'private', createdAt: 1 }).run()
  for (const id of ['c', 'empty']) db.insert(conversations).values({ id, projectId: 'p', userId: 'owner', title: id, agent: 'claude', config: '{}', status: 'idle', createdAt: 1, updatedAt: 1 }).run()
  const log = new EventLog(db)
  for (const event of journal) log.append('c', event)
  const ctx = { db, config: { paths: { data: '/tmp' } } } as AppContext
  return { db, sqlite, log, ctx }
}

test('body projection preserves originals, text, metadata, exact versions and small payloads', (t) => {
  const { log, sqlite } = fixture(t)
  const original = sqlite.prepare('select payload from events order by seq').all()
  const page = log.readForReplay('c', 0, { rows: 100, bytes: 2_000_000, bodies: true })
  assert.equal(page.entries.length, journal.length)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 6000)
  assert.equal(JSON.stringify(page).includes('base64'), false)
  const message = page.entries[0]!.event
  assert.ok(message.type === 'message.completed')
  assert.deepEqual(message.blocks[0], journal[0]!.type === 'message.completed' ? journal[0]!.blocks[0] : null)
  assert.deepEqual(message.blocks[1], { type: 'image', mimeType: 'image/png', url: '/api/conversations/c/events/1/images/1', width: 2, height: 3 })
  assert.equal(log.eventImage('c', 1, 1), url)
  assert.equal(log.eventImage('empty', 1, 1), null)
  assert.equal(log.eventImage('c', 1, 0), null)
  assert.deepEqual(log.eventBody('c', 1, 'input', 2), { value: input })
  assert.deepEqual(log.eventBody('c', 1, 'output', 3), { value: huge })
  assert.equal(log.eventBody('c', 1, 'input', 0), null)
  assert.deepEqual(log.eventBody('c', 2, 'input'), { value: input })
  assert.deepEqual(log.eventBody('c', 4, 'output'), { value: { text: huge } })
  assert.deepEqual(log.eventBody('c', 5, 'patch'), { value: huge })
  assert.equal(log.eventBody('empty', 2, 'input'), null)
  const restored = page.entries.map(({ seq, event }) => {
    const restored = JSON.parse(JSON.stringify(event))
    function hydrate(value: Record<string, unknown>) {
      for (const field of ['input', 'output', 'patch'] as const) {
        const ref = value[`${field}Ref`] as { seq: number; block?: number } | undefined
        if (!ref) continue
        value[field] = log.eventBody('c', ref.seq, field, ref.block)!.value
        delete value[`${field}Ref`]
        if (field === 'output') delete value.outputBytes
      }
    }
    hydrate(restored)
    if (restored.type === 'message.completed') restored.blocks.forEach((block: Record<string, unknown>, index: number) => {
      hydrate(block)
      if (block.type === 'image') { block.url = log.eventImage('c', seq, index); delete block.width; delete block.height }
    })
    return restored
  })
  assert.deepEqual(restored, journal, 'Every projected body must reconstruct its original event')
  assert.deepEqual(sqlite.prepare('select payload from events order by seq').all(), original)
  assert.deepEqual(log.read('c', 0, 100).map((entry) => entry.event), journal)
  assert.equal(JSON.stringify(log.readForReplay('c', 0, { rows: 100, bytes: 2_000_000 })).includes('base64'), true)
  log.append('c', { type: 'tool.completed', toolCallId: 'tool', output: 'new', isError: false, durationMs: 2 })
  assert.deepEqual(log.eventBody('c', 4, 'output'), { value: { text: huge } })
  assert.deepEqual(log.toolOutput('c', 'tool'), { output: 'new' })
  assert.equal(log.withBodies(log.read('c', 5, 1)[0]!).event.type, 'tool.completed')
})

test('live and replay projections agree, including partial inputs and nested tool bodies', (t) => {
  const { log } = fixture(t)
  const live = log.read('c', 0, 100).map((entry) => log.withBodies(entry))
  assert.deepEqual(live, log.readWithBodies('c', 0, 100))
  assert.deepEqual(live, log.readForReplay('c', 0, { rows: 100, bytes: 2_000_000, bodies: true }).entries)
  assert.deepEqual(live[1]!.event.type === 'tool.started' ? live[1]!.event.input : null, { file_path: 'large.ts', description: 'Edit the file' })
  assert.deepEqual(live[2]!.event.type === 'tool.input_updated' ? live[2]!.event.inputRef : null, { seq: 3, field: 'input' })
  const tinyImage = { type: 'tool.completed', toolCallId: 'image', output: [{ type: 'image', url }], isError: false, durationMs: 1 } as const
  log.append('c', tinyImage)
  assert.equal(JSON.stringify(log.readWithBodies('c', 5, 1)).includes('base64'), false)
})

test('large inputs retain subagent identity and schedule approval summaries', async (t) => {
  const { log } = fixture(t)
  log.append('c', { type: 'tool.started', toolCallId: 'agent', name: 'Agent', input: { subagent_type: 'Explore', description: 'Find the code', prompt: huge }, parentToolCallId: null })
  log.append('c', { type: 'tool.started', toolCallId: 'schedule', name: 'sillage/schedule_task', input: { check_script: ' '.repeat(1000) + 'echo ok', prompt: huge }, parentToolCallId: null })
  const id = '11111111-2222-3333-4444-555555555555'
  const text = `Tâche planifiée « Watch » créée, id ${id}.\n${huge}`
  log.append('c', { type: 'tool.completed', toolCallId: 'schedule', output: [{ type: 'text', text }], isError: false, durationMs: 1 })
  const projected = log.readWithBodies('c', 5, 10).map((entry) => entry.event)
  assert.equal(projected[0]!.type === 'tool.started' && (projected[0]!.input as { subagent_type: string }).subagent_type, 'Explore')
  assert.equal(projected[1]!.type === 'tool.started' && (projected[1]!.input as { check_script: string }).check_script, 'echo ok')
  assert.equal(projected[2]!.type === 'tool.completed' && projected[2]!.output, text.slice(0, 512))
  const { scheduledTaskIdOf } = await import('../../web/src/lib/sillage-tools.js')
  assert.equal(projected[2]!.type === 'tool.completed' && scheduledTaskIdOf(projected[2]!.output as string), id)
})

test('unreadable legacy events still produce visible errors instead of breaking replay', (t) => {
  const { sqlite, log } = fixture(t)
  for (const payload of [null, { type: 'message.completed', blocks: 'broken' }, { type: 'message.completed', blocks: [17, 'broken', null] }, { type: 'message.completed', blocks: [{ type: 'unknown' }] }]) {
    sqlite.prepare('update events set payload=? where conversation_id=? and seq=1').run(JSON.stringify(payload), 'c')
    const reference = log.read('c', 0, 1)[0]!.event
    assert.equal(reference.type, 'error')
    assert.deepEqual(log.readWithBodies('c', 0, 1)[0]!.event, reference)
    assert.deepEqual(log.readForReplay('c', 0, { rows: 1, bytes: 4096, bodies: true }).entries[0]!.event, reference)
  }
})

test('image header dimensions are bounded and malformed/unknown headers are harmless', () => {
  assert.deepEqual(imageDimensions(url), { width: 2, height: 3 })
  for (const header of ['', 'data:image/png,broken', 'data:image/png;base64,AAAA', 'data:image/jpeg;base64,/9j/AA==']) assert.equal(imageDimensions(header), undefined)
  const gif = Buffer.from('GIF89a\x02\x00\x03\x00', 'binary')
  assert.deepEqual(imageDimensions('data:image/gif;base64,' + gif.toString('base64')), { width: 2, height: 3 })
})

async function http(t: TestContext) {
  const fixtureData = fixture(t)
  const { db, ctx, log } = fixtureData
  const app = Fastify()
  registerErrorHandler(app)
  app.addHook('onRequest', async (request) => {
    const id = request.headers['x-user']
    if (typeof id === 'string') request.user = db.select().from(users).where(eq(users.id, id)).get()
  })
  const sessions = { statusBus: new EventEmitter(), setNotifier() {}, warmConversationIds: () => [], isWarm: () => false, backgroundCount: () => 0, loopCount: () => 0, appliedConfig: () => null } as unknown as SessionManager
  registerConversationRoutes(app, ctx, log, sessions, {} as AgentRegistry, {} as AttachmentStore, {} as WebhookService)
  await registerWebSocketHub(app, ctx, log, sessions, { setPresence() {} } as unknown as Notifications)
  await app.ready()
  t.after(async () => { for (const socket of app.websocketServer.clients) socket.terminate(); await app.close() })
  return { ...fixtureData, app }
}

test('body/image routes enforce authentication and current shared-conversation visibility', async (t) => {
  const { app, db } = await http(t)
  const routes = ['/api/conversations/c/events/2/body/input', '/api/conversations/c/events/1/images/1']
  for (const route of routes) {
    assert.equal((await app.inject(route)).statusCode, 401)
    assert.equal((await app.inject({ url: route, headers: { 'x-user': 'reader' } })).statusCode, 404)
    assert.equal((await app.inject({ url: route, headers: { 'x-user': 'owner' } })).statusCode, 200)
  }
  db.update(projects).set({ visibility: 'shared' }).where(eq(projects.id, 'p')).run()
  for (const route of routes) {
    const response = await app.inject({ url: route, headers: { 'x-user': 'reader' } })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['cache-control'], 'private, no-store')
    if (route.includes('/images/')) {
      assert.deepEqual(response.rawPayload, png)
      assert.equal(response.headers['x-content-type-options'], 'nosniff')
    } else assert.deepEqual(response.json(), { value: input })
  }
  db.update(projects).set({ visibility: 'private' }).where(eq(projects.id, 'p')).run()
  for (const route of routes) assert.equal((await app.inject({ url: route, headers: { 'x-user': 'reader' } })).statusCode, 404)
  for (const route of ['/api/conversations/empty/events/2/body/input', '/api/conversations/c/events/1/images/0', '/api/conversations/c/events/2/body/output']) {
    assert.equal((await app.inject({ url: route, headers: { 'x-user': 'owner' } })).statusCode, 404)
  }
  for (const route of ['/api/conversations/c/events/-1/body/input', '/api/conversations/c/events/2/body/raw', '/api/conversations/c/events/1/images/0.5', '/api/conversations/c/events/2/body/input?block=-1']) {
    assert.equal((await app.inject({ url: route, headers: { 'x-user': 'owner' } })).statusCode, 400)
  }
  const legacy = await app.inject({ url: '/api/conversations/c/events', headers: { 'x-user': 'owner' } })
  const light = await app.inject({ url: '/api/conversations/c/events?bodies=1', headers: { 'x-user': 'owner' } })
  assert.ok(legacy.body.includes('base64'))
  assert.ok(!light.body.includes('base64'))
})

test('socket opt-in applies to catch-up and live events; legacy sockets keep complete bodies', async (t) => {
  const { app, log } = await http(t)
  for (const bodies of [undefined, 1]) {
    const received: ServerMessage[] = []
    const socket = await app.injectWS('/api/ws', { headers: { 'x-user': 'owner' } }, {
      onInit: (ws) => ws.on('message', (raw) => received.push(JSON.parse(raw.toString()))),
    })
    t.after(() => socket.terminate())
    socket.send(JSON.stringify({ t: 'subscribe', conversationId: 'c', afterSeq: 0, bodies }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(received.some((entry) => entry.t === 'event'))
    assert.equal(JSON.stringify(received).includes('base64'), bodies === undefined)
    received.length = 0
    log.append('c', journal[0]!)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(received.some((entry) => entry.t === 'event'))
    assert.equal(JSON.stringify(received).includes('base64'), bodies === undefined)
    socket.terminate()
  }
})

test('thread projection pages use current conversation access and validate cursors', async (t) => {
  const { app, db, log } = await http(t)
  while (!log.thread.advance('c')) { /* Tiny fixture, no asynchronous rebuild needed. */ }
  const url = '/api/conversations/c/thread'
  assert.equal((await app.inject(url)).statusCode, 401)
  assert.equal((await app.inject({ url, headers: { 'x-user': 'reader' } })).statusCode, 404)
  const owner = await app.inject({ url, headers: { 'x-user': 'owner' } })
  assert.equal(owner.statusCode, 200)
  assert.equal(owner.json().building, false)
  assert.ok(!owner.body.includes('base64'))
  db.update(projects).set({ visibility: 'shared' }).where(eq(projects.id, 'p')).run()
  assert.equal((await app.inject({ url, headers: { 'x-user': 'reader' } })).statusCode, 200)
  db.update(projects).set({ visibility: 'private' }).where(eq(projects.id, 'p')).run()
  assert.equal((await app.inject({ url, headers: { 'x-user': 'reader' } })).statusCode, 404)
  for (const query of ['before=-1', 'after=NaN', 'before=1.5']) {
    assert.equal((await app.inject({ url: `${url}?${query}`, headers: { 'x-user': 'owner' } })).statusCode, 400)
  }
})
