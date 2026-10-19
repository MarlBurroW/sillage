import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import cookie from '@fastify/cookie'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { openDatabase, runMigrations, users } from '@sillage/db'
import { updateAppSettingsBodySchema, type InstanceInfo, type UserSettingsDto } from '@sillage/protocol'
import type { Config } from '../src/config.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerAuthRoutes } from '../src/http/routes/auth.js'
import { registerSystemRoutes } from '../src/http/routes/system.js'
import { registerUserSettingsRoutes } from '../src/http/routes/user-settings.js'
import { registerUserRoutes } from '../src/http/routes/users.js'
import { createSampleProject } from '../src/projects/sample.js'
import { publicUrlOf, readAppSettings, writeAppSettings } from '../src/settings/app-settings.js'
import { readUserSettings } from '../src/settings/user-settings.js'

const run = promisify(execFile)

/** Une base vide, comme à la première ouverture, et les routes que la visite emploie. */
async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-onboarding-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())

  const config = {
    paths: { data: dir },
    server: { publicUrl: '' },
    retention: { autoArchiveDays: 0, autoArchiveSchedule: '0 4 * * *' },
    limits: { maxConcurrentSessions: 4 },
  } as unknown as Config
  const ctx = { db, config }

  const app = Fastify()
  await app.register(cookie)
  // Le compte courant est posé par le test, par l'en-tête `x-user` : pas de cookie à
  // rejouer ici, c'est la route de création qui est exercée, pas le hook de session.
  app.addHook('preHandler', async (request) => {
    const id = request.headers['x-user']
    if (typeof id === 'string') request.user = db.select().from(users).where(eq(users.id, id)).get()
  })
  registerErrorHandler(app)
  registerAuthRoutes(app, ctx)
  registerSystemRoutes(app, ctx)
  registerUserSettingsRoutes(app, ctx)
  registerUserRoutes(app, ctx)
  t.after(() => app.close())

  return { dir, db, ctx, app }
}

test('premier compte : créé une seule fois, administrateur, visite armée, session ouverte', async (t) => {
  const { db, app } = await harness(t)

  const before = await app.inject({ url: '/api/system/instance' })
  assert.equal(before.json<InstanceInfo>().needsSetup, true)
  assert.ok(before.json<InstanceInfo>().hostname.length > 0)

  const created = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'nicolas', displayName: 'Nicolas', password: 'correct horse battery' },
  })
  assert.equal(created.statusCode, 201, created.body)
  assert.equal(created.json().isAdmin, true)
  assert.match(created.headers['set-cookie'] as string, /sillage_session=/)

  const row = db.select().from(users).where(eq(users.username, 'nicolas')).get()
  assert.ok(row)
  assert.equal(row.isAdmin, true)
  const settings = readUserSettings(db, row.id)
  assert.equal(settings.onboarding.pending, true)
  assert.equal(settings.onboarding.step, 0)

  const after = await app.inject({ url: '/api/system/instance' })
  assert.equal(after.json<InstanceInfo>().needsSetup, false)

  // Un second appel n'a plus de raison d'exister : la base a un compte.
  const again = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'intrus', displayName: 'Intrus', password: 'correct horse battery' },
  })
  assert.equal(again.statusCode, 409)
  assert.equal(again.json().error.code, 'setup_done')
})

test('premier compte : mot de passe trop court et identifiant invalide refusés', async (t) => {
  const { app } = await harness(t)
  const short = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'a', displayName: 'A', password: 'court' } })
  assert.equal(short.statusCode, 400)
  const bad = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'pas bon', displayName: 'A', password: 'assez long pourtant' } })
  assert.equal(bad.statusCode, 400)
})

test('la visite se mémorise au compte, et un membre créé par un administrateur l’a due', async (t) => {
  const { db, app } = await harness(t)
  await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'admin', displayName: 'Admin', password: 'correct horse battery' } })
  const admin = db.select().from(users).where(eq(users.username, 'admin')).get()!

  const patched = await app.inject({
    method: 'PATCH',
    url: '/api/me/settings',
    headers: { 'x-user': admin.id },
    payload: {
      onboarding: {
        pending: true,
        step: 3,
        answers: { agents: ['claude'], team: 'team', devices: 'phone', guidance: 'direct', permission: 'acceptEdits' },
        skipped: ['appearance'],
        projectId: null,
      },
    },
  })
  assert.equal(patched.statusCode, 200, patched.body)
  const read = await app.inject({ url: '/api/me/settings', headers: { 'x-user': admin.id } })
  const onboarding = read.json<UserSettingsDto>().onboarding
  assert.equal(onboarding.step, 3)
  assert.deepEqual(onboarding.answers.agents, ['claude'])
  assert.equal(onboarding.answers.permission, 'acceptEdits')
  assert.deepEqual(onboarding.skipped, ['appearance'])

  // Terminée : plus due, et le reste de l'état est libre d'être conservé ou non.
  await app.inject({ method: 'PATCH', url: '/api/me/settings', headers: { 'x-user': admin.id }, payload: { onboarding: { ...onboarding, pending: false } } })
  assert.equal(readUserSettings(db, admin.id).onboarding.pending, false)

  const member = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { 'x-user': admin.id },
    payload: { username: 'bob', displayName: 'Bob', password: 'provisoire-123', isAdmin: false },
  })
  assert.equal(member.statusCode, 201, member.body)
  const bob = db.select().from(users).where(eq(users.username, 'bob')).get()!
  assert.equal(readUserSettings(db, bob.id).onboarding.pending, true)
})

test('adresse publique : la base l’emporte sur le fichier, et la chaîne vide est un choix', async (t) => {
  const { db, ctx } = await harness(t)
  assert.equal(publicUrlOf(db, ctx.config), '')

  const configured = { ...ctx.config, server: { publicUrl: 'https://fichier.example.com' } } as Config
  assert.equal(publicUrlOf(db, configured), 'https://fichier.example.com')

  writeAppSettings(db, { publicUrl: 'https://base.example.com' })
  assert.equal(readAppSettings(db, configured).publicUrl, 'https://base.example.com')

  writeAppSettings(db, { publicUrl: '' })
  assert.equal(readAppSettings(db, configured).publicUrl, '')

  // Le schéma retire la barre finale et refuse un chemin.
  assert.equal(updateAppSettingsBodySchema.parse({ publicUrl: 'https://x.example.com/' }).publicUrl, 'https://x.example.com')
  assert.equal(updateAppSettingsBodySchema.parse({ publicUrl: '' }).publicUrl, '')
  assert.throws(() => updateAppSettingsBodySchema.parse({ publicUrl: 'https://x.example.com/sillage' }))
  assert.throws(() => updateAppSettingsBodySchema.parse({ publicUrl: 'sillage.example.com' }))
})

test('projet d’essai : un dépôt écrit dans le dossier demandé, créé au besoin, avec ses tests', async (t) => {
  const { dir, db, ctx } = await harness(t)
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', isAdmin: true, createdAt: 1 }).run()
  const parent = join(dir, 'projects')

  const row = await createSampleProject(ctx, 'owner', { parentDir: parent, visibility: 'private' })
  assert.equal(row.workspacePath, join(parent, 'sillage-sample'))
  assert.equal(row.instructionsMode, 'sillage')
  assert.equal(row.turnCheckpoints, true)
  for (const name of ['package.json', 'README.md', 'src/cart.js', 'test/cart.test.js']) {
    assert.equal((await stat(join(row.workspacePath, name))).isFile(), true, name)
  }
  assert.match(await readFile(join(row.workspacePath, 'README.md'), 'utf8'), /Sillage sample/)

  // Un dépôt, avec un commit : c'est ce que le panneau git et les points de reprise montrent.
  const log = await run('git', ['log', '--oneline'], { cwd: row.workspacePath }).catch(() => null)
  if (log) assert.equal(log.stdout.trim().split('\n').length, 1)

  // Les tests échouent exprès : c'est le premier travail à confier à l'agent. Lancés hors
  // du contexte de ce test runner, sans quoi le `--test` enfant se prend pour un des nôtres.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_OPTIONS
  const tests = await run(process.execPath, ['--test'], { cwd: row.workspacePath, env }).then(
    () => 'passed',
    () => 'failed',
  )
  assert.equal(tests, 'failed')

  // Un second projet d'essai ne s'écrit pas par-dessus le premier.
  const second = await createSampleProject(ctx, 'owner', { parentDir: parent, visibility: 'private' })
  assert.equal(second.workspacePath, join(parent, 'sillage-sample-2'))
})
