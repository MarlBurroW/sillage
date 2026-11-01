import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { eq } from 'drizzle-orm'
import { attachments, cards, openDatabase, projects, runMigrations, users } from '@sillage/db'
import { MAX_ATTACHMENT_BYTES } from '@sillage/protocol'
import { AttachmentStore } from '../src/attachments/store.js'
import type { Config } from '../src/config.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerCardRoutes } from '../src/http/routes/cards.js'
import { registerAttachmentRoutes } from '../src/http/routes/attachments.js'

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-card-files-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  for (const id of ['owner', 'other']) db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'Test', workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const app = Fastify()
  await app.register(multipart)
  app.addHook('preHandler', async (request) => { request.user = db.select().from(users).where(eq(users.id, String(request.headers['x-user'] ?? 'owner'))).get() })
  registerErrorHandler(app)
  const ctx = { db, config: {} as Config }
  const store = new AttachmentStore(db, join(dir, 'attachments'))
  registerCardRoutes(app, ctx, store)
  registerAttachmentRoutes(app, store, ctx)
  t.after(() => app.close())
  const response = await app.inject({ method: 'POST', url: '/api/projects/project/cards', payload: { title: 'Ticket' } })
  assert.equal(response.statusCode, 201, response.body)
  const card = response.json()
  const upload = (content = Buffer.from('Brief pour les agents'), user = 'owner', id = card.id, file = { name: 'brief.md', type: 'text/markdown' }) => app.inject({
    method: 'POST', url: `/api/cards/${id}/attachments`, headers: { 'x-user': user, 'content-type': 'multipart/form-data; boundary=FILE' },
    payload: Buffer.concat([Buffer.from(`--FILE\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), content, Buffer.from('\r\n--FILE--\r\n')]),
  })
  return { app, db, dbPath, store, card, upload }
}

test('ticket files: upload, project permissions, agent read, orphan protection and deletion', async (t) => {
  const { app, db, dbPath, store, card, upload } = await harness(t)
  const response = await upload()
  assert.equal(response.statusCode, 201, response.body)
  const file = response.json()
  const row = store.get(file.id)!
  assert.equal(row.cardId, card.id)
  assert.equal(await readFile(row.storagePath, 'utf8'), 'Brief pour les agents')
  const listing = await app.inject(`/api/cards/${card.id}/attachments`)
  assert.equal(listing.json()[0].filename, 'brief.md')
  assert.equal(listing.json()[0].storagePath, undefined, 'Local paths are not leaked in the web API')
  assert.equal((await app.inject('/api/projects/project/cards')).json()[0].attachmentCount, 1)
  assert.deepEqual(store.listClaimable('owner', [file.id]), [], 'Ticket files cannot be claimed by chat')
  assert.equal((await app.inject({ url: `/api/attachments/${file.id}`, headers: { 'x-user': 'other' } })).statusCode, 404)
  assert.equal((await upload(Buffer.from('Forbidden'), 'other')).statusCode, 404)
  assert.equal((await app.inject({ url: `/api/cards/${card.id}/attachments`, headers: { 'x-user': 'other' } })).statusCode, 404)
  db.update(projects).set({ visibility: 'shared' }).where(eq(projects.id, 'project')).run()
  const shared = await app.inject({ url: `/api/attachments/${file.id}`, headers: { 'x-user': 'other' } })
  assert.equal(shared.statusCode, 200)
  assert.equal(shared.body, 'Brief pour les agents')
  assert.equal(shared.headers['cache-control'], 'private, no-store')
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/attachments/${file.id}` })).statusCode, 400)

  db.update(attachments).set({ createdAt: 1 }).where(eq(attachments.id, file.id)).run()
  assert.equal(await store.purgeOrphans(), 0, 'An old ticket attachment is not an abandoned upload')
  const mcp = spawnSync(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
    env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: 'project' }, encoding: 'utf8',
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_card', arguments: { number: card.number } } }) + '\n', timeout: 10000,
  })
  assert.equal(mcp.status, 0, mcp.stderr)
  assert.ok(mcp.stdout.includes(row.storagePath), mcp.stdout)
  assert.ok(mcp.stdout.includes('brief.md'))
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/cards/not-this-card/attachments/${file.id}` })).statusCode, 404)
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/cards/${card.id}/attachments/${file.id}`, headers: { 'x-user': 'other' } })).statusCode, 204)
  assert.equal(store.get(file.id), undefined)
  await assert.rejects(stat(row.storagePath))

  const second = (await upload()).json()
  const secondPath = store.get(second.id)!.storagePath
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/cards/${card.id}` })).statusCode, 204)
  assert.equal(store.get(second.id), undefined)
  await assert.rejects(stat(secondPath))
})

test('ticket files: empty/oversized uploads rejected; cascaded project deletion leaves collectable files', async (t) => {
  const { db, store, upload } = await harness(t)
  assert.equal((await upload(Buffer.alloc(0))).statusCode, 400)
  assert.equal((await upload(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 65))).statusCode, 400)
  assert.equal(db.select().from(attachments).all().length, 0)
  const file = (await upload()).json()
  db.update(attachments).set({ createdAt: 1 }).where(eq(attachments.id, file.id)).run()
  db.delete(projects).where(eq(projects.id, 'project')).run()
  assert.equal(db.select().from(cards).all().length, 0)
  assert.equal(store.get(file.id)?.cardId, null)
  assert.equal(await store.purgeOrphans(), 1)
})

test('media attachments play in place: inline disposition and byte ranges for seeking', async (t) => {
  const { app, upload } = await harness(t)
  const response = await upload(Buffer.from('0123456789'), 'owner', undefined, { name: 'demo.mp4', type: 'video/mp4' })
  assert.equal(response.statusCode, 201, response.body)
  const url = `/api/attachments/${response.json().id}`
  const whole = await app.inject(url)
  assert.equal(whole.statusCode, 200)
  assert.match(whole.headers['content-disposition'] as string, /^inline;/)
  assert.equal(whole.headers['accept-ranges'], 'bytes')
  assert.equal(whole.body, '0123456789')
  const slice = await app.inject({ url, headers: { range: 'bytes=2-4' } })
  assert.equal(slice.statusCode, 206)
  assert.equal(slice.headers['content-range'], 'bytes 2-4/10')
  assert.equal(slice.body, '234')
  const tail = await app.inject({ url, headers: { range: 'bytes=-3' } })
  assert.equal(tail.statusCode, 206)
  assert.equal(tail.body, '789')
  assert.equal((await app.inject({ url, headers: { range: 'bytes=10-' } })).statusCode, 416)
  const document = await upload()
  assert.match((await app.inject(`/api/attachments/${document.json().id}`)).headers['content-disposition'] as string, /^attachment;/)
})
