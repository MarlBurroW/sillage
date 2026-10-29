import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { cardTagLinks, cards, openDatabase, projects, runMigrations, users } from '@sillage/db'
import type { CardDto, CardTagCatalogDto } from '@sillage/protocol'
import { registerCardRoutes } from '../src/http/routes/cards.js'
import { registerErrorHandler } from '../src/http/errors.js'
import type { Config } from '../src/config.js'
import type { AttachmentStore } from '../src/attachments/store.js'

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-tags-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  for (const id of ['owner', 'guest']) {
    db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', createdAt: 1 }).run()
  }
  for (const id of ['project', 'other']) {
    db.insert(projects).values({ id, name: id, workspacePath: dir, ownerId: 'owner', visibility: id === 'project' ? 'shared' : 'private', createdAt: 1 }).run()
    for (const number of [1, 2]) {
      db.insert(cards).values({ id: `${id}-${number}`, projectId: id, number, title: `Ticket ${number}`, column: 'todo', createdBy: 'owner', createdAt: 1, updatedAt: 1 }).run()
    }
  }
  const app = Fastify()
  app.addHook('onRequest', async (request) => {
    const userId = request.headers.authorization
    if (userId) request.user = db.select().from(users).where(eq(users.id, userId)).get() ?? null
  })
  registerErrorHandler(app)
  registerCardRoutes(app, { db, config: {} as Config }, {} as AttachmentStore)
  t.after(() => app.close())
  const call = async <T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object, user = 'owner') => {
    const response = await app.inject({ method, url, payload, headers: { authorization: user } })
    return { status: response.statusCode, body: response.json() as T }
  }
  return { db, call }
}

test('tags: case-insensitive names, rotating colors, card assignment and merge', async (t) => {
  const { db, call } = await harness(t)
  const first = await call<CardTagCatalogDto>('POST', '/api/projects/project/card-tags', { name: '  Bug  ', description: 'Broken behavior' })
  assert.equal(first.status, 201)
  assert.equal(first.body.tags[0]?.name, 'Bug')
  assert.equal((await call('POST', '/api/projects/project/card-tags', { name: 'bug' })).status, 409)
  const second = await call<CardTagCatalogDto>('POST', '/api/projects/project/card-tags', { name: 'Défaut' })
  const [bug, defect] = [second.body.tags.find((tag) => tag.name === 'Bug')!, second.body.tags.find((tag) => tag.name === 'Défaut')!]
  assert.notEqual(bug.color, defect.color)

  const tagged = await call<CardDto>('PATCH', '/api/cards/project-1', { tagIds: [bug.id, defect.id] })
  assert.deepEqual(tagged.body.tags.map((tag) => tag.name), ['Bug', 'Défaut'])
  await call('PATCH', '/api/cards/project-2', { tagIds: [defect.id] })
  // A tag of another project is refused and leaves the card unchanged.
  const foreign = await call<CardTagCatalogDto>('POST', '/api/projects/other/card-tags', { name: 'Ailleurs' })
  assert.equal((await call('PATCH', '/api/cards/project-1', { tagIds: [foreign.body.tags[0]!.id], title: 'Changed' })).status, 404)
  assert.equal(db.select().from(cards).where(eq(cards.id, 'project-1')).get()?.title, 'Ticket 1')

  const merged = await call<CardTagCatalogDto>('POST', `/api/card-tags/${defect.id}/merge`, { into: bug.id })
  assert.deepEqual(merged.body.tags.map((tag) => [tag.name, tag.cardCount]), [['Bug', 2]])
  assert.equal(db.select().from(cardTagLinks).all().length, 2)

  assert.equal((await call('PATCH', `/api/card-tags/${bug.id}`, { name: 'Régression' })).status, 200)
  const board = await call<CardDto[]>('GET', '/api/projects/project/cards')
  assert.deepEqual(board.body.map((card) => card.tags.map((tag) => tag.name)), [['Régression'], ['Régression']])
  await call('DELETE', `/api/card-tags/${bug.id}`)
  assert.equal(db.select().from(cardTagLinks).all().length, 0)
})

test('tags: collaborators manage the catalog, only the owner closes it to agents', async (t) => {
  const { call } = await harness(t)
  assert.equal((await call('POST', '/api/projects/project/card-tags', { name: 'ui' }, 'guest')).status, 201)
  assert.equal((await call('PUT', '/api/projects/project/card-tags/settings', { agentsCanCreate: false }, 'guest')).status, 403)
  const closed = await call<CardTagCatalogDto>('PUT', '/api/projects/project/card-tags/settings', { agentsCanCreate: false })
  assert.equal(closed.body.agentsCanCreate, false)
  assert.equal((await call('GET', '/api/projects/other/card-tags', undefined, 'guest')).status, 404)
})
