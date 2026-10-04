import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { conversations, openDatabase, projects, runMigrations, users } from '@sillage/db'
import type { ServerMessage } from '@sillage/protocol'
import type { Config } from '../src/config.js'
import type { EventLog } from '../src/events/event-log.js'
import type { PushService } from '../src/push/push-service.js'
import type { SessionManager } from '../src/sessions/session-manager.js'
import type { AgentRegistry } from '../src/agents/registry.js'
import type { AttachmentStore } from '../src/attachments/store.js'
import type { CloneJobs } from '../src/clone-jobs.js'
import type { TerminalManager } from '../src/terminals/terminal-manager.js'
import type { WebhookService } from '../src/webhooks/service.js'
import { registerClaudeSessionRoutes } from '../src/http/routes/claude-sessions.js'
import { registerConversationRoutes } from '../src/http/routes/conversations.js'
import { registerProjectRoutes } from '../src/http/routes/projects.js'
import { registerV1Routes } from '../src/http/v1/index.js'
import { LIST_ROUTES, registerWebSocketHub } from '../src/ws/hub.js'

async function database(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-ws-hub-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())

  for (const id of ['owner', 'other']) {
    db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', createdAt: 1 }).run()
  }
  db.insert(projects).values({ id: 'private', name: 'private', workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  db.insert(conversations).values({
    id: 'c1', projectId: 'private', userId: 'owner', title: 'Session', agent: 'claude', config: '{}',
    status: 'running', createdAt: 1, updatedAt: 1,
  }).run()

  return { dir, db, ctx: { db, config: { paths: { data: dir } } as Config } }
}

/** Le compte vient d'un en-tête : le hook d'authentification réel lit un cookie. */
function authenticate(app: FastifyInstance, db: Awaited<ReturnType<typeof database>>['db']) {
  app.addHook('onRequest', async (request) => {
    const id = request.headers['x-user']
    if (typeof id === 'string') request.user = db.select().from(users).where(eq(users.id, id)).get()
  })
}

function stubSessions(warm: string[] = []) {
  return {
    statusBus: new EventEmitter(),
    setNotifier: () => {},
    warmConversationIds: () => warm,
    isWarm: (id: string) => warm.includes(id),
    backgroundCount: () => 2,
    loopCount: () => 0,
    appliedConfig: () => null,
  } as unknown as SessionManager
}

async function hub(t: TestContext, warm: string[] = []) {
  const { db, ctx } = await database(t)
  const sessions = stubSessions(warm)
  const app = Fastify()
  authenticate(app, db)

  // Déclarées avant le hub, comme dans `buildApp` : le hook doit s'y appliquer quand même.
  app.patch('/api/conversations/:id', async (request, reply) =>
    (request.params as { id: string }).id === 'missing' ? reply.code(404).send({}) : { ok: true })
  app.put('/api/conversations/:id/favorite', async () => ({ favorite: true }))
  app.post('/api/conversations/:id/read', async () => ({ lastReadSeq: 1 }))

  await registerWebSocketHub(app, ctx, {} as EventLog, sessions, {} as PushService)
  await app.ready()
  // Les deux bouts coupés net : une fermeture polie attend la réponse de l'autre côté,
  // que les flux simulés de `injectWS` ne transmettent pas, et `ws` patiente alors 30 s.
  t.after(async () => {
    for (const client of app.websocketServer.clients) client.terminate()
    await app.close()
  })

  const connect = async (user: string) => {
    const received: ServerMessage[] = []
    const socket = await app.injectWS('/api/ws', { headers: { 'x-user': user } }, {
      // Avant l'ouverture : l'instantané de statuts part dès la connexion.
      onInit: (ws) => ws.on('message', (raw) => received.push(JSON.parse(raw.toString()) as ServerMessage)),
    })
    t.after(() => socket.terminate())
    return received
  }

  return { app, sessions, connect }
}

/** Les messages traversent des flux asynchrones : on attend un peu avant de conclure. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))
const listsChanged = (messages: ServerMessage[]) => messages.filter((m) => m.t === 'lists-changed').length

test('un changement de liste réussi prévient tous les onglets', async (t) => {
  const { app, connect } = await hub(t)
  const owner = await connect('owner')
  const other = await connect('other')

  await app.inject({ method: 'PATCH', url: '/api/conversations/c1', headers: { 'x-user': 'owner' } })
  await settle()

  assert.equal(listsChanged(owner), 1)
  assert.equal(listsChanged(other), 1)
})

test('un échec ne prévient personne', async (t) => {
  const { app, connect } = await hub(t)
  const owner = await connect('owner')

  await app.inject({ method: 'PATCH', url: '/api/conversations/missing', headers: { 'x-user': 'owner' } })
  await settle()

  assert.equal(listsChanged(owner), 0)
})

test('un signet ne prévient que les onglets de son compte', async (t) => {
  const { app, connect } = await hub(t)
  const owner = await connect('owner')
  const other = await connect('other')

  await app.inject({ method: 'PUT', url: '/api/conversations/c1/favorite', headers: { 'x-user': 'owner' } })
  await settle()

  assert.equal(listsChanged(owner), 1)
  assert.equal(listsChanged(other), 0)
})

test('le curseur de lecture ne fait pas relire la liste', async (t) => {
  const { app, connect } = await hub(t)
  const owner = await connect('owner')

  await app.inject({ method: 'POST', url: '/api/conversations/c1/read', headers: { 'x-user': 'owner' } })
  await settle()

  assert.equal(listsChanged(owner), 0)
})

test('un titre proposé fait relire la liste à qui peut lire le fil', async (t) => {
  const { sessions, connect } = await hub(t)
  const owner = await connect('owner')
  const other = await connect('other')

  sessions.statusBus.emit('title', { conversationId: 'c1', title: 'Nouveau titre' })
  await settle()

  assert.equal(listsChanged(owner), 1)
  assert.equal(listsChanged(other), 0)
})

test('un socket qui arrive reçoit le statut des sessions vivantes qu’il peut lire', async (t) => {
  const { connect } = await hub(t, ['c1'])
  const owner = await connect('owner')
  const other = await connect('other')
  await settle()

  const status = owner.find((m) => m.t === 'status')
  assert.ok(status && status.t === 'status')
  assert.equal(status.conversationId, 'c1')
  assert.equal(status.background, 2)
  assert.equal(other.some((m) => m.t === 'status'), false)
})

test('chaque route de LIST_ROUTES existe', async (t) => {
  const { ctx } = await database(t)
  const app = Fastify()
  // Les collaborateurs ne sont jamais appelés : seule la déclaration des routes compte.
  const sessions = stubSessions()
  registerProjectRoutes(app, ctx, {} as AttachmentStore, {} as CloneJobs, {} as TerminalManager)
  registerConversationRoutes(app, ctx, {} as EventLog, sessions, {} as AgentRegistry, {} as AttachmentStore, {} as WebhookService)
  registerClaudeSessionRoutes(app, ctx, {} as EventLog, sessions, {} as AgentRegistry)
  registerV1Routes(app, ctx, {} as EventLog, sessions, {} as AgentRegistry, {} as WebhookService)
  await app.ready()
  t.after(() => app.close())

  for (const key of Object.keys(LIST_ROUTES)) {
    const [method, url] = key.split(' ') as [string, string]
    assert.ok(app.hasRoute({ method: method as 'GET', url }), `route absente : ${key}`)
  }
})
