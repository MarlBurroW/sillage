import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { openDatabase, runMigrations, users, projects, conversations, worktrees, conversationPaths } from '@sillage/db'
import { registerFileRoutes } from '../../src/http/routes/files.js'
import { registerErrorHandler } from '../../src/http/errors.js'
import type { AppContext } from '../../src/http/context.js'

export async function localImages() {
  const directory = await mkdtemp(join(tmpdir(), 'sillage-local-images-'))
  const root = join(directory, 'main')
  const linked = join(directory, 'linked')
  const other = join(directory, 'other')
  for (const folder of [root, linked, other]) await mkdir(join(folder, '.preview'), { recursive: true })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  for (const folder of [linked, other]) await writeFile(join(folder, '.preview/image.png'), png)
  const { db, sqlite } = openDatabase(join(directory, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'Owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'Project', workspacePath: root, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  db.insert(conversations).values({ id: 'session', projectId: 'project', userId: 'owner', title: 'Images', agent: 'codex', config: '{}', status: 'idle', createdAt: 1, updatedAt: 1 }).run()
  for (const [id, path] of [['linked', linked], ['other', other]] as const) {
    db.insert(worktrees).values({ id, projectId: 'project', name: id, path, baseRef: 'main', createdBy: 'owner', createdAt: 1 }).run()
  }
  db.insert(conversationPaths).values({ conversationId: 'session', path: linked, lastTs: 1 }).run()
  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    if (request.headers['x-test-user'] !== 'stranger') request.user = db.select().from(users).get()
  })
  registerErrorHandler(app)
  registerFileRoutes(app, { db } as AppContext)
  return { app, db, root, linked, other, directory, png, close: async () => { await app.close(); sqlite.close(); await rm(directory, { recursive: true, force: true }) } }
}
