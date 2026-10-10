import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { openDatabase, projects, runMigrations, users } from '@sillage/db'
import type { ApiScope } from '@sillage/protocol'
import { createApiToken, resolveApiToken, bearerSecret } from '../src/auth/api-tokens.js'
import type { Config } from '../src/config.js'
import type { AgentRegistry } from '../src/agents/registry.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerProjectCreationRoutes } from '../src/http/v1/projects.js'
import { registerDiscoveryRoutes } from '../src/http/v1/discovery.js'
import { loadProjectForToken } from '../src/http/v1/access.js'

async function harness(t: TestContext, scopes: ApiScope[] = ['projects:read', 'projects:write'], projectIds: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-api-projects-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'Owner', passwordHash: '', createdAt: 1 }).run()
  const { row: token, secret } = createApiToken(db, {
    userId: 'owner', label: 'test', scopes, projectIds, agent: 'claude', config: {}, expiresAt: null, webhookUrl: null,
  })
  const app = Fastify()
  app.addHook('onRequest', async (request) => {
    const secret = bearerSecret(request.headers.authorization)
    const identity = secret ? resolveApiToken(db, secret) : null
    if (identity) { request.user = identity.user; request.apiToken = identity.token }
  })
  registerErrorHandler(app)
  const ctx = { db, config: {} as Config }
  registerProjectCreationRoutes(app, ctx)
  registerDiscoveryRoutes(app, ctx, {} as AgentRegistry)
  t.after(() => app.close())
  const headers = { authorization: `Bearer ${secret}` }
  const create = (payload: object, auth = headers) => app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth, payload })
  return { dir, app, db, ctx, token, headers, create }
}

test('API : rattacher un dossier, propriétaire et découverte utilisables pour les tâches', async (t) => {
  const h = await harness(t)
  await writeFile(join(h.dir, 'AGENTS.md'), '# Consignes')
  const response = await h.create({ name: 'Projet API', workspacePath: h.dir })
  assert.equal(response.statusCode, 201, response.body)
  const dto = response.json()
  assert.equal(dto.workspacePath, h.dir)
  assert.equal(dto.git, false)
  assert.deepEqual(dto.defaults, { agent: 'claude', config: {} })
  const row = loadProjectForToken(h.ctx, h.token, 'owner', dto.id)
  assert.equal(row.ownerId, 'owner')
  assert.equal(row.visibility, 'private')
  assert.equal(row.instructionsMode, 'repo')
  const list = await h.app.inject({ url: '/api/v1/projects', headers: h.headers })
  assert.deepEqual(list.json(), [dto])
})

test('API : créer un dossier et respecter les options du projet', async (t) => {
  const h = await harness(t)
  const response = await h.create({ name: 'Nouveau', parentDir: h.dir, directory: 'nouveau', visibility: 'shared', color: '#123456' })
  assert.equal(response.statusCode, 201, response.body)
  assert.ok((await stat(join(h.dir, 'nouveau'))).isDirectory())
  const row = h.db.select().from(projects).get()!
  assert.equal(row.visibility, 'shared')
  assert.equal(row.color, '#123456')
  assert.equal(row.instructionsMode, 'sillage')
})

for (const [label, scopes, ids] of [
  ['portée absente', ['projects:read'], []],
  ['jeton restreint', ['projects:write'], ['existing']],
] as [string, ApiScope[], string[]][]) {
  test(`API : refuser ${label} avant tout effet`, async (t) => {
    const h = await harness(t, scopes, ids)
    const response = await h.create({ name: 'Refus', parentDir: h.dir, directory: 'refus' })
    assert.equal(response.statusCode, 403, response.body)
    assert.equal(h.db.select().from(projects).all().length, 0)
    await assert.rejects(stat(join(h.dir, 'refus')))
  })
}

test('API : authentification et chemins invalides', async (t) => {
  const h = await harness(t)
  assert.equal((await h.create({ name: 'Test', workspacePath: h.dir }, {})).statusCode, 401)
  await writeFile(join(h.dir, 'file'), 'contenu')
  for (const payload of [
    { name: '', workspacePath: h.dir },
    { name: 'Test', workspacePath: 'relative' },
    { name: 'Test', workspacePath: join(h.dir, 'missing') },
    { name: 'Test', workspacePath: join(h.dir, 'file') },
    { name: 'Test', parentDir: h.dir, directory: '../escape' },
  ]) assert.equal((await h.create(payload)).statusCode, 400)
  const response = await h.create({ name: 'Test', parentDir: h.dir, directory: 'occupied' })
  assert.equal(response.statusCode, 201)
  await writeFile(join(h.dir, 'occupied', 'file'), 'contenu')
  assert.equal((await h.create({ name: 'Test', parentDir: h.dir, directory: 'occupied' })).statusCode, 409)
  assert.equal(h.db.select().from(projects).all().length, 1)
})
