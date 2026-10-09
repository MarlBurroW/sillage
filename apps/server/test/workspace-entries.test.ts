import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { unzipSync } from 'fflate'
import { openDatabase, projects, runMigrations, users } from '@sillage/db'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerTreeRoutes } from '../src/http/routes/tree.js'
import type { AppContext } from '../src/http/context.js'
import { copyEntry } from '../src/workspace.js'

async function workspace(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-entries-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function harness(t: TestContext) {
  const data = await workspace(t)
  const root = join(data, 'ws')
  await mkdir(root)
  const { db, sqlite } = openDatabase(join(data, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'p', name: 'p', workspacePath: root, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()

  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, 'owner')).get()
  })
  registerErrorHandler(app)
  registerTreeRoutes(app, { db } as unknown as AppContext)
  t.after(() => app.close())
  return { app, root, data }
}

test('copier sur place suffixe le nom sans jamais écraser', async (t) => {
  const root = await workspace(t)
  await writeFile(join(root, 'notes.md'), 'a')
  await writeFile(join(root, '.env'), 'b')

  assert.equal(await copyEntry(root, 'notes.md', ''), 'notes copy.md')
  assert.equal(await copyEntry(root, 'notes.md', ''), 'notes copy 2.md')
  assert.equal(await copyEntry(root, '.env', ''), '.env copy')
  assert.equal(await readFile(join(root, 'notes copy 2.md'), 'utf8'), 'a')
})

test('copier un dossier ailleurs garde son nom et son contenu', async (t) => {
  const root = await workspace(t)
  await mkdir(join(root, 'src/lib'), { recursive: true })
  await writeFile(join(root, 'src/lib/a.ts'), 'x')
  await mkdir(join(root, 'dest'))

  assert.equal(await copyEntry(root, 'src', 'dest'), 'dest/src')
  assert.equal(await readFile(join(root, 'dest/src/lib/a.ts'), 'utf8'), 'x')
  // Un dossier n'a pas d'extension : « v1.2 » ne devient pas « v1 copy.2 ».
  await mkdir(join(root, 'v1.2'))
  assert.equal(await copyEntry(root, 'v1.2', ''), 'v1.2 copy')
})

test('la copie refuse un dossier dans lui-même et une cible hors du workspace', async (t) => {
  const root = await workspace(t)
  const outside = await workspace(t)
  await mkdir(join(root, 'src/inner'), { recursive: true })
  await writeFile(join(outside, 'secret'), 's')
  await symlink(outside, join(root, 'link'))

  await assert.rejects(copyEntry(root, 'src', 'src/inner'), { code: 'copy_into_self' })
  await assert.rejects(copyEntry(root, 'link/secret', ''), { code: 'path_outside_workspace' })
  await assert.rejects(copyEntry(root, '.git/config', ''), { code: 'git_internals' })
  assert.deepEqual((await readdir(root)).sort(), ['link', 'src'])
})

test('une sélection se télécharge en zip, nommée depuis son dossier commun', async (t) => {
  const { app, root } = await harness(t)
  await mkdir(join(root, 'pkg/a/src'), { recursive: true })
  await mkdir(join(root, 'pkg/b/src'), { recursive: true })
  await mkdir(join(root, 'pkg/b/empty'))
  await mkdir(join(root, 'pkg/a/.git'))
  await writeFile(join(root, 'pkg/a/src/x.ts'), 'export const x = 1\n')
  await writeFile(join(root, 'pkg/a/.git/HEAD'), 'ref')
  await writeFile(join(root, 'pkg/b/src/y.png'), Buffer.from([1, 2, 3]))

  const response = await app.inject({
    method: 'GET',
    url: '/api/projects/p/entries/archive?path=pkg/a&path=pkg/b&path=pkg/a/src/x.ts',
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'application/zip')
  assert.match(String(response.headers['content-disposition']), /filename\*=UTF-8''pkg\.zip$/)

  const files = unzipSync(new Uint8Array(response.rawPayload))
  assert.deepEqual(Object.keys(files).sort(), [
    'a/', 'a/src/', 'a/src/x.ts', 'b/', 'b/empty/', 'b/src/', 'b/src/y.png',
  ])
  assert.equal(Buffer.from(files['a/src/x.ts'] as Uint8Array).toString(), 'export const x = 1\n')
})

test("l'archive d'un seul dossier porte son nom, et refuse ce qui sort du workspace", async (t) => {
  const { app, root, data } = await harness(t)
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'docs/readme.md'), 'r')
  await writeFile(join(data, 'secret'), 's')
  await symlink(data, join(root, 'escape'))

  const single = await app.inject({ method: 'GET', url: '/api/projects/p/entries/archive?path=docs' })
  assert.match(String(single.headers['content-disposition']), /''docs\.zip$/)
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(single.rawPayload))).sort(), [
    'docs/', 'docs/readme.md',
  ])

  const escaped = await app.inject({
    method: 'GET',
    url: '/api/projects/p/entries/archive?path=escape/secret',
  })
  assert.equal(escaped.statusCode, 400)
  assert.equal(escaped.json().error.code, 'path_outside_workspace')
})

test('la route de copie renvoie le chemin créé', async (t) => {
  const { app, root } = await harness(t)
  await writeFile(join(root, 'a.txt'), 'a')

  const response = await app.inject({
    method: 'POST',
    url: '/api/projects/p/entries/copy',
    payload: { from: 'a.txt', toParent: '' },
  })
  assert.equal(response.statusCode, 201)
  assert.deepEqual(response.json(), { path: 'a copy.txt' })
})
