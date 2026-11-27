import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { conversations, openDatabase, projects, runMigrations, users } from '@sillage/db'
import { AttachmentStore } from '../src/attachments/store.js'
import { conversationMediaRoot, ensureConversationMediaDir, purgeOrphanMedia } from '../src/conversations/media.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerFileRoutes } from '../src/http/routes/files.js'
import type { AppContext } from '../src/http/context.js'
import { instructionsAppendix } from '../src/instructions/store.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')

/**
 * Two accounts; a private project and a shared one, both owned by `owner`, each with one
 * conversation; a media folder holding a screenshot for each conversation.
 */
async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-media-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const data = join(dir, 'data')
  const workspace = join(dir, 'workspace')
  await mkdir(workspace, { recursive: true })
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  t.after(() => sqlite.close())
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  for (const id of ['owner', 'member']) {
    db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', createdAt: 1 }).run()
  }
  for (const [id, visibility] of [['private', 'private'], ['shared', 'shared']] as const) {
    db.insert(projects).values({ id, name: id, workspacePath: workspace, ownerId: 'owner', visibility, createdAt: 1 }).run()
    db.insert(conversations).values({ id: `${id}-session`, projectId: id, userId: 'owner', title: id, agent: 'claude', config: '{}', status: 'idle', createdAt: 1, updatedAt: 1 }).run()
  }
  const root = conversationMediaRoot(data)
  const shot = async (conversationId: string, name = 'shot.png', content: Buffer | string = PNG) => {
    const file = join(ensureConversationMediaDir(root, conversationId), name)
    await writeFile(file, content)
    return file
  }
  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    const id = request.headers['x-user']
    if (id !== 'nobody') request.user = db.select().from(users).where(eq(users.id, String(id ?? 'owner'))).get()
  })
  registerErrorHandler(app)
  registerFileRoutes(app, { db, config: { paths: { data } } } as unknown as AppContext)
  t.after(() => app.close())
  const raw = (path: string, user = 'owner', scope = '/api/conversations/private-session') =>
    app.inject({ url: `${scope}/file/raw?path=${encodeURIComponent(path)}`, headers: { 'x-user': user } })
  const exists = async (paths: string[], user = 'owner', scope = '/api/conversations/private-session') =>
    (await app.inject({ method: 'POST', url: `${scope}/files/exist`, payload: { paths }, headers: { 'x-user': user } })).json().files as string[]
  return { dir, data, db, root, workspace, app, shot, raw, exists }
}

test('a media folder image displays for readers of its conversation, from any scope', async (t) => {
  const h = await harness(t)
  const own = await h.shot('private-session')
  const shared = await h.shot('shared-session')

  assert.deepEqual(await h.exists([own, shared, '/var/tmp/private.png']), [own, shared])
  const response = await h.raw(own)
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.rawPayload, PNG)
  assert.equal(response.headers['content-type'], 'image/png')
  // The path's own conversation decides, not the conversation or project the reader is in: a
  // fork or a handoff quotes its source's images.
  assert.equal((await h.raw(own, 'owner', '/api/conversations/shared-session')).statusCode, 200)
  assert.equal((await h.raw(own, 'owner', '/api/projects/private')).statusCode, 200)
  const download = await h.app.inject({ url: `/api/conversations/private-session/file/download?path=${encodeURIComponent(own)}`, headers: { 'x-user': 'owner' } })
  assert.equal(download.statusCode, 200)
  assert.deepEqual(download.rawPayload, PNG)

  // A member reads the shared project's conversation, never the private one's.
  assert.equal((await h.raw(shared, 'member', '/api/conversations/shared-session')).statusCode, 200)
  assert.equal((await h.raw(own, 'member', '/api/conversations/shared-session')).statusCode, 404)
  assert.deepEqual(await h.exists([own, shared], 'member', '/api/conversations/shared-session'), [shared])
  assert.equal((await h.raw(own, 'nobody')).statusCode, 401)
})

test('a media folder offers viewable files only, and nothing outside itself', async (t) => {
  const h = await harness(t)
  const folder = ensureConversationMediaDir(h.root, 'private-session')
  const notes = await h.shot('private-session', 'notes.txt', 'secret')
  assert.deepEqual(await h.exists([notes]), [])
  assert.equal((await h.raw(notes)).statusCode, 415)
  assert.equal((await h.app.inject({ url: `/api/conversations/private-session/file?path=${encodeURIComponent(notes)}` })).statusCode, 400)

  // A link planted in the folder must not lead out of it.
  const outside = join(h.dir, 'outside.png')
  await writeFile(outside, PNG)
  await symlink(outside, join(folder, 'escape.png'))
  assert.equal((await h.raw(join(folder, 'escape.png'))).statusCode, 404)
  assert.deepEqual(await h.exists([join(folder, 'escape.png')]), [])

  // Folders of unknown conversations, and the media root itself, name nothing.
  const ghost = join(ensureConversationMediaDir(h.root, 'ghost'), 'shot.png')
  await writeFile(ghost, PNG)
  assert.equal((await h.raw(ghost)).statusCode, 404)
  assert.equal((await h.raw(join(h.root, 'shot.png'))).statusCode, 404)
  assert.equal((await h.raw(join(folder, '..', 'ghost', 'shot.png'))).statusCode, 404)
})

test('a workspace that contains the data directory cannot bypass the media rule', async (t) => {
  const h = await harness(t)
  const own = await h.shot('private-session')
  h.db.update(projects).set({ workspacePath: h.dir, visibility: 'shared' }).where(eq(projects.id, 'shared')).run()
  assert.equal((await h.raw(own, 'member', '/api/conversations/shared-session')).statusCode, 404)
  assert.equal((await h.raw(own, 'member', '/api/projects/shared')).statusCode, 404)
})

test('media folders leave with their conversation', async (t) => {
  const h = await harness(t)
  await h.shot('private-session')
  await h.shot('shared-session')
  const attachments = new AttachmentStore(h.db, join(h.data, 'attachments'), h.root)
  await attachments.removeForConversations(['private-session'])
  await assert.rejects(access(join(h.root, 'private-session')))
  await access(join(h.root, 'shared-session'))

  // A folder whose conversation vanished another way goes at the next sweep.
  ensureConversationMediaDir(h.root, 'ghost')
  h.db.delete(conversations).where(eq(conversations.id, 'shared-session')).run()
  assert.equal(await purgeOrphanMedia(h.db, h.root), 2)
  await assert.rejects(access(join(h.root, 'ghost')))
  await assert.rejects(access(join(h.root, 'shared-session')))
  assert.equal(await purgeOrphanMedia(h.db, join(h.dir, 'absent')), 0)
})

test('agents are told where to put the images they show', async (t) => {
  const h = await harness(t)
  const dir = ensureConversationMediaDir(h.root, 'private-session')
  const appendix = instructionsAppendix(h.db, { projectId: 'private', mode: 'repo', sillageMcp: false, mediaDir: dir }) ?? ''
  assert.ok(appendix.includes(`\`${dir}\``), appendix)
  assert.match(appendix, /\$SILLAGE_MEDIA_DIR/)
  assert.doesNotMatch(appendix, /copy it into the working directory/)
  // Without a folder (probes), the former advice stands.
  assert.match(instructionsAppendix(h.db, { projectId: 'private', mode: 'repo', sillageMcp: false }) ?? '', /copy it into the working directory/)
})
