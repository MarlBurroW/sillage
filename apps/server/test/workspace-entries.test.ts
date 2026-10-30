import assert from 'node:assert/strict'
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { unzipSync } from 'fflate'
import { openDatabase, projects, runMigrations, users } from '@sillage/db'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerFileRoutes } from '../src/http/routes/files.js'
import { registerTreeRoutes } from '../src/http/routes/tree.js'
import type { AppContext } from '../src/http/context.js'
import { copyEntry, createEntry, deleteEntry, listDirectory, moveEntry, writeUpload } from '../src/workspace.js'

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
  registerFileRoutes(app, { db } as unknown as AppContext)
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
  // Directories have no extensions: 'v1.2' must not become 'v1 copy.2'.
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

const exists = (path: string) => access(path).then(() => true, () => false)

test('file reads and writes do not follow symlinks out of the workspace', async (t) => {
  const { app, root, data } = await harness(t)
  await mkdir(join(data, 'outside'))
  await writeFile(join(data, 'outside/secret.txt'), 'secret')
  await symlink(join(data, 'outside'), join(root, 'escape'))
  await symlink(join(data, 'outside/missing.txt'), join(root, 'dangling.txt'))
  await writeFile(join(root, 'AGENTS.md'), '# Agents\n')
  await symlink('AGENTS.md', join(root, 'CLAUDE.md'))

  const read = await app.inject({ method: 'GET', url: '/api/projects/p/file?path=escape/secret.txt' })
  assert.equal(read.statusCode, 400)
  assert.equal(read.json().error.code, 'path_outside_workspace')
  // The refusal names the requested path, not where the link leads.
  assert.doesNotMatch(read.body, /outside\/secret/)

  const raw = await app.inject({ method: 'GET', url: '/api/projects/p/file/raw?path=escape/secret.pdf' })
  assert.notEqual(raw.statusCode, 200)

  const write = await app.inject({
    method: 'PUT',
    url: '/api/projects/p/file',
    payload: { path: 'escape/planted.txt', content: 'x', fingerprint: null },
  })
  assert.equal(write.statusCode, 400)
  assert.equal(await exists(join(data, 'outside/planted.txt')), false)

  // Writing a dangling link would create its target outside.
  const dangling = await app.inject({
    method: 'PUT',
    url: '/api/projects/p/file',
    payload: { path: 'dangling.txt', content: 'x', fingerprint: null },
  })
  assert.equal(dangling.statusCode, 404)
  assert.equal(await exists(join(data, 'outside/missing.txt')), false)

  // A link that stays inside works both ways and writes its target.
  const inside = await app.inject({ method: 'GET', url: '/api/projects/p/file?path=CLAUDE.md' })
  assert.equal(inside.statusCode, 200)
  assert.equal(inside.json().content, '# Agents\n')
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/projects/p/file',
    payload: { path: 'CLAUDE.md', content: '# Agents v2\n', fingerprint: inside.json().fingerprint },
  })
  assert.equal(saved.statusCode, 200)
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), '# Agents v2\n')
  assert.ok((await lstat(join(root, 'CLAUDE.md'))).isSymbolicLink())

  const exist = await app.inject({
    method: 'POST',
    url: '/api/projects/p/files/exist',
    payload: { paths: ['escape/secret.txt', 'CLAUDE.md'] },
  })
  assert.deepEqual(exist.json(), { files: ['CLAUDE.md'] })
})

test('entry operations do not reach through a symlinked directory', async (t) => {
  const root = await workspace(t)
  const outside = await workspace(t)
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(outside, join(root, 'escape'))
  await writeFile(join(root, 'a.txt'), 'a')
  const refused = { code: 'path_outside_workspace' }

  await assert.rejects(listDirectory(root, 'escape'), refused)
  await assert.rejects(createEntry(root, 'escape', 'new.txt', 'file'), refused)
  await assert.rejects(createEntry(root, 'escape/deep', 'dir', 'directory'), refused)
  await assert.rejects(writeUpload(root, 'escape/upload.txt', Readable.from(['x']), () => false), refused)
  await assert.rejects(moveEntry(root, 'a.txt', 'escape/a.txt'), refused)
  await assert.rejects(moveEntry(root, 'escape/secret.txt', 'stolen.txt'), refused)
  await assert.rejects(copyEntry(root, 'a.txt', 'escape'), refused)
  await assert.rejects(deleteEntry(root, 'escape/secret.txt'), refused)
  assert.deepEqual((await readdir(outside)).sort(), ['secret.txt'])

  // The link itself remains an ordinary entry: renaming or deleting it leaves its target alone.
  await moveEntry(root, 'escape', 'renamed')
  await deleteEntry(root, 'renamed')
  assert.deepEqual((await readdir(root)).sort(), ['a.txt'])
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret')
})

test('reading flags text that is not UTF-8 and keeps a byte order mark', async (t) => {
  const { app, root } = await harness(t)
  await writeFile(join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  await writeFile(join(root, 'bom.txt'), Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a]))

  const latin1 = await app.inject({ method: 'GET', url: '/api/projects/p/file?path=latin1.txt' })
  assert.equal(latin1.json().lossy, true)

  const bom = await app.inject({ method: 'GET', url: '/api/projects/p/file?path=bom.txt' })
  assert.equal(bom.json().lossy, false)
  assert.equal(bom.json().content, '\ufeffa\n')
})

test('saving accepts a file near the editable limit despite JSON escaping', async (t) => {
  const { app, root } = await harness(t)
  // About 1.9 MB of quotes and line breaks: each takes two bytes once escaped in JSON.
  const line = '{"key":"value","other":"thing"},\n'
  const content = line.repeat(Math.floor(1_900_000 / line.length))
  await writeFile(join(root, 'big.json'), content)
  const read = await app.inject({ method: 'GET', url: '/api/projects/p/file?path=big.json' })

  const saved = await app.inject({
    method: 'PUT',
    url: '/api/projects/p/file',
    payload: { path: 'big.json', content: `${content}x`, fingerprint: read.json().fingerprint },
  })
  assert.equal(saved.statusCode, 200)
  assert.equal(await readFile(join(root, 'big.json'), 'utf8'), `${content}x`)
})

test('the fingerprint route follows writes without sending the content', async (t) => {
  const { app, root } = await harness(t)
  await writeFile(join(root, 'notes.md'), 'a')
  const read = await app.inject({ method: 'GET', url: '/api/projects/p/file?path=notes.md' })
  const first = await app.inject({ method: 'GET', url: '/api/projects/p/file/fingerprint?path=notes.md' })
  assert.deepEqual(first.json(), { fingerprint: read.json().fingerprint })

  await writeFile(join(root, 'notes.md'), 'ab')
  const second = await app.inject({ method: 'GET', url: '/api/projects/p/file/fingerprint?path=notes.md' })
  assert.notEqual(second.json().fingerprint, first.json().fingerprint)

  const missing = await app.inject({ method: 'GET', url: '/api/projects/p/file/fingerprint?path=gone.md' })
  assert.equal(missing.statusCode, 404)
})
