import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { openDatabase, runMigrations, users } from '@sillage/db'
import type { ProjectDto, ProjectMemoryDto } from '@sillage/protocol'
import type { Config } from '../src/config.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerMemoryRoutes } from '../src/http/routes/memory.js'
import { registerProjectRoutes } from '../src/http/routes/projects.js'
import { registerUserSettingsRoutes } from '../src/http/routes/user-settings.js'
import type { AttachmentStore } from '../src/attachments/store.js'
import type { CloneJobs } from '../src/clone-jobs.js'
import type { TerminalManager } from '../src/terminals/terminal-manager.js'
import { writeProjectDefaults } from '../src/settings/user-settings.js'

/** Account defaults for future project instructions and memory locations. Set by onboarding, used when creation omits choices; memory mode remains editable per project afterward. */
async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-project-defaults-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', isAdmin: true, createdAt: 1 }).run()

  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, 'owner')).get()
  })
  registerErrorHandler(app)
  const ctx = { db, config: { paths: { data: dir, memory: join(dir, 'memory') } } as Config }
  registerProjectRoutes(app, ctx, {} as AttachmentStore, {} as CloneJobs, { aliveCount: () => 0 } as unknown as TerminalManager)
  registerUserSettingsRoutes(app, ctx)
  registerMemoryRoutes(app, ctx)
  t.after(() => app.close())

  const parent = join(dir, 'projects')
  await mkdir(parent)
  const create = async (body: Record<string, unknown>) => {
    const response = await app.inject({ method: 'POST', url: '/api/projects', payload: { parentDir: parent, ...body } })
    assert.equal(response.statusCode, 201, response.body)
    return response.json<ProjectDto>()
  }
  return { dir, db, app, parent, create }
}

test('sans défaut : consignes selon le dossier, mémoire dans Sillage', async (t) => {
  const { create, parent } = await harness(t)
  const plain = await create({ name: 'Plain', directory: 'plain' })
  assert.equal(plain.instructionsMode, 'sillage')
  assert.equal(plain.memoryMode, 'sillage')

  // Existing AGENTS.md directories retain repository instructions.
  await mkdir(join(parent, 'with-agents'))
  await writeFile(join(parent, 'with-agents', 'AGENTS.md'), '# rules\n')
  const repo = await create({ name: 'With agents', workspacePath: join(parent, 'with-agents') })
  assert.equal(repo.instructionsMode, 'repo')
})

test('les défauts du compte s’appliquent quand la création ne dit rien, et seulement alors', async (t) => {
  const { db, app, create, parent } = await harness(t)
  const patched = await app.inject({
    method: 'PATCH',
    url: '/api/me/settings',
    payload: { projectDefaults: { instructionsMode: 'sillage', memoryMode: 'native' } },
  })
  assert.equal(patched.statusCode, 200, patched.body)
  assert.deepEqual(patched.json().projectDefaults, { instructionsMode: 'sillage', memoryMode: 'native' })

  // Account choice 'in Sillage' applies even with AGENTS.md present.
  await mkdir(join(parent, 'with-agents'))
  await writeFile(join(parent, 'with-agents', 'AGENTS.md'), '# rules\n')
  const project = await create({ name: 'Defaults', workspacePath: join(parent, 'with-agents') })
  assert.equal(project.instructionsMode, 'sillage')
  assert.equal(project.memoryMode, 'native')

  // Explicit creation choices override defaults.
  const explicit = await create({ name: 'Explicit', directory: 'explicit', instructionsMode: 'repo', memoryMode: 'sillage' })
  assert.equal(explicit.instructionsMode, 'repo')
  assert.equal(explicit.memoryMode, 'sillage')

  // Repository defaults also apply to empty directories.
  writeProjectDefaults(db, 'owner', { instructionsMode: 'repo', memoryMode: 'sillage' })
  const repo = await create({ name: 'Repo', directory: 'repo' })
  assert.equal(repo.instructionsMode, 'repo')
})

test('mode mémoire natif : rien à lire ni à écrire, et le retour vers Sillage rend le dossier', async (t) => {
  const { app, create } = await harness(t)
  const project = await create({ name: 'Native', directory: 'native', memoryMode: 'native' })

  const native = await app.inject({ url: `/api/projects/${project.id}/memory` })
  assert.equal(native.statusCode, 200, native.body)
  const nativeDto = native.json<ProjectMemoryDto>()
  assert.equal(nativeDto.mode, 'native')
  assert.deepEqual(nativeDto.files, [])
  assert.equal(nativeDto.dir, '')

  const write = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/memory/note.md`, payload: { content: 'x' } })
  assert.equal(write.statusCode, 400)
  assert.equal(write.json().error.code, 'memory_native')

  const switched = await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload: { memoryMode: 'sillage' } })
  assert.equal(switched.statusCode, 200, switched.body)
  const sillage = await app.inject({ url: `/api/projects/${project.id}/memory` })
  const sillageDto = sillage.json<ProjectMemoryDto>()
  assert.equal(sillageDto.mode, 'sillage')
  assert.ok(sillageDto.dir.endsWith(join('projects', project.id)))
})
