import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { openDatabase, projects, runMigrations, users } from '@sillage/db'
import type { Config } from '../src/config.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerSkillLibraryRoutes } from '../src/http/routes/skill-library.js'
import { SkillLibrary } from '../src/skill-library/store.js'

/**
 * Une base migrée dans un dossier jetable : un admin, un propriétaire de projets, un
 * membre et un étranger ; deux projets partagés et un privé, tous au propriétaire.
 */
export function harness(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-skills-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())

  const user = (id: string, isAdmin: boolean) => ({ id, username: id, displayName: id, passwordHash: '', isAdmin, createdAt: 1 })
  db.insert(users).values([user('admin', true), user('owner', false), user('member', false), user('stranger', false)]).run()
  const project = (id: string, visibility: 'private' | 'shared') =>
    ({ id, name: id, workspacePath: join(dir, 'workspace'), ownerId: 'owner', visibility, createdAt: 1 })
  db.insert(projects).values([project('p1', 'shared'), project('p2', 'shared'), project('secret', 'private')]).run()

  const root = join(dir, 'library')
  const changes: (string | null)[] = []
  const library = new SkillLibrary(db, root, (projectId) => changes.push(projectId))
  return { dir, db, root, library, changes }
}

/** La même bibliothèque derrière les routes, l'utilisateur choisi par en-tête. */
export async function http(t: TestContext) {
  const h = harness(t)
  const app = Fastify()
  await app.register(multipart, { limits: { files: 1 } })
  app.addHook('preHandler', async (request) => {
    const id = (request.headers['x-user'] as string | undefined) ?? 'admin'
    request.user = h.db.select().from(users).where(eq(users.id, id)).get()
  })
  registerErrorHandler(app)
  const config = { skills: { library: true }, paths: { skillLibrary: h.root } } as Config
  registerSkillLibraryRoutes(app, { db: h.db, config }, h.library)
  t.after(() => app.close())

  type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  const call = (user: string, method: Method, url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as object, headers: { 'x-user': user } })
  /** Envoi d'un fichier, comme le fait le navigateur. */
  const upload = (user: string, url: string, filename: string, content: Uint8Array) => {
    const boundary = `----sillage${randomUUID()}`
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    return app.inject({
      method: 'POST',
      url,
      payload: Buffer.concat([Buffer.from(head), Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`)]),
      headers: { 'x-user': user, 'content-type': `multipart/form-data; boundary=${boundary}` },
    })
  }
  return { ...h, call, upload }
}

export const createSkill = (library: SkillLibrary, overrides: Partial<Parameters<SkillLibrary['create']>[0]> = {}) =>
  library.create({ scope: 'global', projectId: null, name: 'deploy', description: 'Use when deploying.', body: 'Run it.', ...overrides }, 'admin')
