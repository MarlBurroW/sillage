import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { openDatabase, runMigrations, users } from '@sillage/db'
import { slugifyProjectName, type ProjectDto } from '@sillage/protocol'
import type { Config } from '../src/config.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerProjectRoutes } from '../src/http/routes/projects.js'
import { registerUserSettingsRoutes } from '../src/http/routes/user-settings.js'
import type { AttachmentStore } from '../src/attachments/store.js'
import type { CloneJobs } from '../src/clone-jobs.js'
import type { TerminalManager } from '../src/terminals/terminal-manager.js'
import { readUserSettings } from '../src/settings/user-settings.js'

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-projects-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', isAdmin: false, createdAt: 1 }).run()

  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, 'owner')).get()
  })
  registerErrorHandler(app)
  const ctx = { db, config: { paths: { data: dir } } as Config }
  // Seule la création de projet est exercée : les autres collaborateurs ne sont jamais appelés.
  registerProjectRoutes(app, ctx, {} as AttachmentStore, {} as CloneJobs, { aliveCount: () => 0 } as unknown as TerminalManager)
  registerUserSettingsRoutes(app, ctx)
  t.after(() => app.close())

  const create = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/projects', payload: body })

  return { dir, db, app, create }
}

test('slug : accents, espaces et ponctuation', () => {
  assert.equal(slugifyProjectName('Mon Projet Été'), 'mon-projet-ete')
  assert.equal(slugifyProjectName('  --Sillage v2 (beta)!  '), 'sillage-v2-beta')
  assert.equal(slugifyProjectName('déjà-vu'), 'deja-vu')
  assert.equal(slugifyProjectName('...'), '')
})

test('création : nouveau dossier créé dans le parent, et parent mémorisé', async (t) => {
  const { dir, db, app, create } = await harness(t)
  const parent = join(dir, 'projects')
  await mkdir(parent)

  const response = await create({ name: 'Mon Projet', parentDir: parent, directory: 'mon-projet' })
  assert.equal(response.statusCode, 201, response.body)
  const project = response.json<ProjectDto>()
  assert.equal(project.workspacePath, join(parent, 'mon-projet'))
  assert.equal((await stat(project.workspacePath)).isDirectory(), true)
  assert.equal(readUserSettings(db, 'owner').projectsDir, parent)

  const settings = await app.inject({ url: '/api/me/settings' })
  assert.equal(settings.json().projectsDir, parent)

  // Un second projet du même nom vise un dossier maintenant occupé : refusé, rien n'est écrasé.
  await mkdir(join(parent, 'mon-projet', 'src'))
  const duplicate = await create({ name: 'Mon Projet', parentDir: parent, directory: 'mon-projet' })
  assert.equal(duplicate.statusCode, 409)

  // Un dossier existant mais vide est accepté, comme un mkdir fait d'avance.
  await mkdir(join(parent, 'vide'))
  const empty = await create({ name: 'Vide', parentDir: parent, directory: 'vide' })
  assert.equal(empty.statusCode, 201, empty.body)
})

test('création : garde-fous sur le nom de dossier et le parent', async (t) => {
  const { dir, create } = await harness(t)
  const parent = join(dir, 'projects')
  await mkdir(parent)

  for (const directory of ['../evasion', 'a/b', '.hidden']) {
    const response = await create({ name: 'X', parentDir: parent, directory })
    assert.equal(response.statusCode, 400, `${directory}: ${response.body}`)
  }
  const missing = await create({ name: 'X', parentDir: join(dir, 'absent'), directory: 'x' })
  assert.equal(missing.statusCode, 400)
  const relative = await create({ name: 'X', parentDir: 'relative', directory: 'x' })
  assert.equal(relative.statusCode, 400)
})

test('création : le chemin libre existant fonctionne toujours, sans toucher au dossier mémorisé', async (t) => {
  const { dir, db, create } = await harness(t)
  const elsewhere = join(dir, 'ailleurs', 'repo')
  await mkdir(elsewhere, { recursive: true })

  const response = await create({ name: 'Ailleurs', workspacePath: elsewhere })
  assert.equal(response.statusCode, 201, response.body)
  assert.equal(response.json<ProjectDto>().workspacePath, elsewhere)
  assert.equal(readUserSettings(db, 'owner').projectsDir, null)

  const missing = await create({ name: 'Absent', workspacePath: join(dir, 'nope') })
  assert.equal(missing.statusCode, 400)
})

test('réglages : projectsDir se pose et se retire par PATCH', async (t) => {
  const { dir, app } = await harness(t)
  const set = await app.inject({ method: 'PATCH', url: '/api/me/settings', payload: { projectsDir: dir } })
  assert.equal(set.statusCode, 200)
  assert.equal(set.json().projectsDir, dir)
  const clear = await app.inject({ method: 'PATCH', url: '/api/me/settings', payload: { projectsDir: null } })
  assert.equal(clear.json().projectsDir, null)
})

test('épingle : personnelle, idempotente, et reflétée dans la liste', async (t) => {
  const { dir, app, create } = await harness(t)
  const parent = join(dir, 'projects')
  await mkdir(parent)
  const project = (await create({ name: 'Épinglé', parentDir: parent, directory: 'epingle' })).json<ProjectDto>()
  assert.equal(project.pinned, false)

  for (let i = 0; i < 2; i++) {
    const pin = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/pin` })
    assert.equal(pin.statusCode, 200, pin.body)
  }
  let list = (await app.inject({ method: 'GET', url: '/api/projects' })).json<ProjectDto[]>()
  assert.equal(list.find((entry) => entry.id === project.id)?.pinned, true)

  const unpin = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/pin` })
  assert.equal(unpin.statusCode, 200, unpin.body)
  list = (await app.inject({ method: 'GET', url: '/api/projects' })).json<ProjectDto[]>()
  assert.equal(list.find((entry) => entry.id === project.id)?.pinned, false)

  const missing = await app.inject({ method: 'PUT', url: '/api/projects/nope/pin' })
  assert.equal(missing.statusCode, 404)
})
