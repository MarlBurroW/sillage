import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { cardRelations, cards, openDatabase, projects, runMigrations, users } from '@sillage/db'
import { CARD_RELATION_INVERSE, type StoredCardRelationKind } from '@sillage/protocol'
import { linkCards, listCardRelations, unlinkCards } from '../src/board/card-relations.js'
import { registerCardRoutes } from '../src/http/routes/cards.js'
import { registerErrorHandler } from '../src/http/errors.js'
import type { Config } from '../src/config.js'
import type { AttachmentStore } from '../src/attachments/store.js'

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-relations-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'Owner', passwordHash: '', createdAt: 1 }).run()
  for (const id of ['project', 'other']) {
    db.insert(projects).values({ id, name: id, workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
    for (const number of [1, 2, 3, 4]) db.insert(cards).values({ id: `${id}-${number}`, projectId: id, number, title: `Ticket ${number}`, column: 'todo', createdBy: 'owner', createdAt: 1, updatedAt: 1 }).run()
  }
  const app = Fastify()
  app.addHook('onRequest', async request => {
    const userId = request.headers.authorization
    if (userId) request.user = db.select().from(users).where(eq(users.id, userId)).get() ?? null
  })
  registerErrorHandler(app)
  registerCardRoutes(app, { db, config: {} as Config }, {} as AttachmentStore)
  t.after(() => app.close())
  return { db, app }
}

for (const kind of ['blocks', 'related', 'duplicates', 'parent', 'replaces'] as StoredCardRelationKind[]) {
  test(`relations ${kind} : les deux sens, déduplication et suppression depuis l’inverse`, async t => {
    const { db } = await harness(t)
    linkCards(db, 'project', 1, 2, kind)
    const outgoing = listCardRelations(db, 'project', 1)[0]!
    const incoming = listCardRelations(db, 'project', 2)[0]!
    assert.equal(outgoing.kind, kind)
    assert.equal(incoming.kind, CARD_RELATION_INVERSE[kind])
    assert.equal(outgoing.id, incoming.id)
    assert.equal(incoming.card.number, 1)
    linkCards(db, 'project', 2, 1, CARD_RELATION_INVERSE[kind])
    assert.equal(db.select().from(cardRelations).all().length, 1)
    // Une relation ne change jamais la colonne ou la description.
    assert.ok(db.select().from(cards).all().every(c => c.column === 'todo' && c.description === ''))
    unlinkCards(db, 'project', 2, 1, incoming.kind)
    assert.deepEqual(listCardRelations(db, 'project', 1), [])
    assert.deepEqual(listCardRelations(db, 'project', 2), [])
  })
}

test('refuser les boucles et les parents multiples ; cascader à la suppression', async t => {
  const { db } = await harness(t)
  assert.throws(() => linkCards(db, 'project', 1, 1, 'related'), /itself/)
  for (const kind of ['blocks', 'parent', 'replaces', 'duplicates'] as StoredCardRelationKind[]) {
    linkCards(db, 'project', 1, 2, kind)
    linkCards(db, 'project', 2, 3, kind)
    assert.throws(() => linkCards(db, 'project', 3, 1, kind), /cycle/)
  }
  assert.throws(() => linkCards(db, 'project', 4, 2, 'parent'), /already has a parent/)
  assert.equal(listCardRelations(db, 'project', 4).length, 0)
  db.delete(cards).where(eq(cards.id, 'project-2')).run()
  assert.equal(db.select().from(cardRelations).all().length, 0)
})

test('API : autorisation, isolement du projet, validation et vue inverse', async t => {
  const { app, db } = await harness(t)
  const url = '/api/cards/project-1/relations'
  assert.equal((await app.inject({ url })).statusCode, 401)
  assert.equal((await app.inject({ method: 'POST', url, payload: { target: 2, kind: 'related' } })).statusCode, 401)
  const headers = { authorization: 'owner' }
  const added = await app.inject({ method: 'POST', url, headers, payload: { target: 2, kind: 'blocked_by' } })
  assert.equal(added.statusCode, 200, added.body)
  assert.equal(added.json()[0].kind, 'blocked_by')
  assert.equal((await app.inject({ url: '/api/cards/project-2/relations', headers })).json()[0].kind, 'blocks')
  assert.deepEqual((await app.inject({ url: '/api/cards/other-2/relations', headers })).json(), [])
  const missing = await app.inject({ method: 'POST', url, headers, payload: { target: 99, kind: 'related' } })
  assert.equal(missing.statusCode, 404)
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { target: 2, kind: 'invalid' } })).statusCode, 400)
  assert.equal(db.select().from(cardRelations).all().length, 1)
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/cards/project-2/relations', headers, payload: { target: 1, kind: 'blocks' } })).statusCode, 204)
  assert.deepEqual((await app.inject({ url, headers })).json(), [])
})

test('API : un autre compte ne lit ni ne modifie les relations d’un projet privé', async t => {
  const { app, db } = await harness(t)
  db.insert(users).values({ id: 'visitor', username: 'visitor', displayName: 'Visitor', passwordHash: '', createdAt: 1 }).run()
  linkCards(db, 'project', 1, 2, 'blocks')
  for (const method of ['GET', 'POST', 'DELETE'] as const) {
    const response = await app.inject({ method, url: '/api/cards/project-1/relations',
      headers: { authorization: 'visitor' },
      ...(method === 'GET' ? {} : { payload: { target: 2, kind: 'blocks' } }),
    })
    assert.equal(response.statusCode, 404, response.body)
  }
  assert.equal(db.select().from(cardRelations).all().length, 1)
  db.update(projects).set({ visibility: 'shared' }).where(eq(projects.id, 'project')).run()
  const shared = await app.inject({ method: 'DELETE', url: '/api/cards/project-1/relations',
    headers: { authorization: 'visitor' }, payload: { target: 2, kind: 'blocks' },
  })
  assert.equal(shared.statusCode, 204, shared.body)
})
