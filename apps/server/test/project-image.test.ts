import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { eq } from 'drizzle-orm'
import { openDatabase, projects, runMigrations, users } from '@sillage/db'
import type { ProjectDto } from '@sillage/protocol'
import { projectOverview } from '../src/agents/overview.js'
import type { AttachmentStore } from '../src/attachments/store.js'
import type { CloneJobs } from '../src/clone-jobs.js'
import type { Config } from '../src/config.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerProjectRoutes } from '../src/http/routes/projects.js'
import type { TerminalManager } from '../src/terminals/terminal-manager.js'

const SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-project-image-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()

  const app = Fastify()
  await app.register(multipart)
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, 'owner')).get()
  })
  registerErrorHandler(app)
  const ctx = { db, config: { paths: { data: dir } } as Config }
  registerProjectRoutes(app, ctx, {} as AttachmentStore, {} as CloneJobs, { aliveCount: () => 0 } as unknown as TerminalManager)
  t.after(() => app.close())

  const upload = (content: Buffer | string) => {
    const boundary = 'sillage-test'
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="logo"\r\ncontent-type: application/octet-stream\r\n\r\n`),
      Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    return app.inject({
      method: 'PUT', url: '/api/projects/project/image', payload,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    })
  }
  const listed = async () => (await app.inject({ url: '/api/projects' })).json<ProjectDto[]>()[0]!

  const mcp = (args: object) => {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
      env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: 'project', SILLAGE_MCP_CONVERSATION: 'c' },
      encoding: 'utf8', timeout: 10000,
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_project_image', arguments: args } }) + '\n',
    })
    assert.equal(run.status, 0, run.stderr)
    return JSON.parse(run.stdout).result as { content: { text: string }[]; isError?: boolean }
  }
  const overview = (sillageMcp = true) =>
    projectOverview(db, { projectId: 'project', conversationId: 'c', sillageMcp })

  return { dir, app, upload, listed, mcp, overview }
}

test('image envoyée par une personne : servie, versionnée, puis retirée', async (t) => {
  const { app, upload, listed } = await harness(t)
  assert.equal((await listed()).image, null)

  assert.equal((await upload('pas une image')).statusCode, 400)
  assert.equal((await upload(Buffer.alloc(1024 * 1024 + 1, 1))).statusCode, 400)

  const response = await upload(SVG)
  assert.equal(response.statusCode, 200, response.body)
  const image = (await listed()).image
  assert.ok(image)
  assert.equal(image.provisional, false)

  const served = await app.inject({ url: image.url })
  assert.equal(served.statusCode, 200)
  assert.equal(served.headers['content-type'], 'image/svg+xml')
  assert.match(String(served.headers['content-security-policy']), /sandbox/)
  assert.equal(served.body, SVG)

  assert.equal((await app.inject({ method: 'DELETE', url: '/api/projects/project/image' })).statusCode, 204)
  assert.equal((await listed()).image, null)
  assert.equal((await app.inject({ url: image.url })).statusCode, 404)
})

test("rappel aux agents : absent, puis provisoire, puis plus rien", async (t) => {
  const { dir, upload, listed, mcp, overview } = await harness(t)

  assert.match(overview() ?? '', /n'a pas d'image/)
  // Sans l'outil pour agir, le rappel ne ferait que du bruit.
  assert.equal(overview(false), null)

  await writeFile(join(dir, 'notes.txt'), 'rien à voir')
  assert.equal(mcp({ path: join(dir, 'notes.txt') }).isError, true)
  assert.equal(mcp({ path: join(dir, 'absent.png') }).isError, true)
  assert.match(overview() ?? '', /n'a pas d'image/)

  await writeFile(join(dir, 'draft.svg'), SVG)
  assert.equal(mcp({ path: join(dir, 'draft.svg'), provisional: true }).isError, undefined)
  assert.equal((await listed()).image?.provisional, true)
  assert.match(overview() ?? '', /provisoire/)

  await writeFile(join(dir, 'logo.png'), PNG)
  assert.equal(mcp({ path: join(dir, 'logo.png') }).isError, undefined)
  assert.equal((await listed()).image?.provisional, false)
  assert.equal(overview(), null)

  // Une image choisie à la main remplace celle d'un agent, et n'est jamais provisoire.
  mcp({ path: join(dir, 'draft.svg'), provisional: true })
  assert.equal((await upload(PNG)).statusCode, 200)
  assert.equal(overview(), null)
})
