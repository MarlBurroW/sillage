import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { openDatabase, projects, runMigrations, users } from '@sillage/db'
import type { ProjectMemoryDto } from '@sillage/protocol'
import type { Config } from '../src/config.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerMemoryRoutes } from '../src/http/routes/memory.js'
import {
  claudeNativeMemoryDir,
  ensureProjectMemory,
  memoryAppendixForCodex,
  projectMemoryDir,
} from '../src/memory/store.js'

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-memory-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  // La mémoire Claude d'avant, dans un CLAUDE_CONFIG_DIR jetable.
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  })

  const workspace = join(dir, 'ws')
  await mkdir(workspace)
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'Owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: workspace, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()

  const root = join(dir, 'memory')
  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, 'owner')).get()
  })
  registerErrorHandler(app)
  registerMemoryRoutes(app, { db, config: { paths: { data: dir, memory: root } } as Config })
  t.after(() => app.close())

  const memoryDir = projectMemoryDir(root, 'project')
  const mcp = (name: string, args: object = {}) => {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
      env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: 'project', SILLAGE_MCP_CONVERSATION: 'c', SILLAGE_MCP_MEMORY: memoryDir },
      encoding: 'utf8', timeout: 10000,
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
    })
    assert.equal(run.status, 0, run.stderr)
    const result = JSON.parse(run.stdout).result as { content: { text: string }[]; isError?: boolean }
    return { ...result, text: result.content[0]!.text }
  }
  const memory = async () => (await app.inject({ url: '/api/projects/project/memory' })).json<ProjectMemoryDto>()

  return { root, workspace, memoryDir, app, mcp, memory }
}

const NOTE = '---\nname: port-du-serveur\ndescription: Le serveur de dev écoute sur 4242\nmetadata:\n  type: project\n---\n\nPort 4242.\n'

test('premier lancement : la mémoire Claude du workspace est copiée, une seule fois', async (t) => {
  const { root, workspace, memoryDir, memory } = await harness(t)
  const native = claudeNativeMemoryDir(workspace)
  await mkdir(native, { recursive: true })
  await writeFile(join(native, 'MEMORY.md'), '- [Ancienne](ancienne.md) — note d’avant\n')
  await writeFile(join(native, 'ancienne.md'), 'Une note d’avant.')

  const listed = await memory()
  assert.deepEqual(listed.files.map((file) => file.file), ['MEMORY.md', 'ancienne.md'])
  assert.equal(listed.importedFrom?.dir, native)
  // L'original reste, pour une session lancée hors de Sillage.
  assert.equal(await readFile(join(native, 'ancienne.md'), 'utf8'), 'Une note d’avant.')

  // Vidée à la main, elle ne se remplit pas de nouveau.
  await rm(join(memoryDir, 'ancienne.md'))
  await rm(join(memoryDir, 'MEMORY.md'))
  ensureProjectMemory(root, 'project', workspace)
  assert.deepEqual((await memory()).files, [])
})

test('interface : lire, écrire, supprimer une note avec sa ligne d’index', async (t) => {
  const { app, memory } = await harness(t)
  assert.equal((await memory()).importedFrom, null)

  const put = (file: string, content: string) =>
    app.inject({ method: 'PUT', url: `/api/projects/project/memory/${file}`, payload: { content } })
  assert.equal((await put('MEMORY.md', '- [Port](port.md) — 4242\n- [Autre](autre.md)\n')).statusCode, 204)
  assert.equal((await put('port.md', NOTE)).statusCode, 204)
  assert.equal((await put('..%2Fevil.md', 'x')).statusCode, 400)
  assert.equal((await put('notes.txt', 'x')).statusCode, 400)

  assert.equal((await app.inject({ method: 'DELETE', url: '/api/projects/project/memory/port.md' })).statusCode, 204)
  const after = await memory()
  assert.deepEqual(after.files.map((file) => file.file), ['MEMORY.md'])
  assert.equal(after.files[0]!.content, '- [Autre](autre.md)\n')
})

test('outils MCP : Codex lit, écrit et retire des notes, l’index suit', async (t) => {
  const { memoryDir, mcp, memory } = await harness(t)
  await memory()

  assert.match(mcp('read_memory').text, /Mémoire vide/)
  assert.equal(mcp('write_memory', { file: '../evil.md', content: 'x' }).isError, true)

  const written = mcp('write_memory', { file: 'port-du-serveur.md', content: NOTE })
  assert.equal(written.isError, undefined)
  assert.match(written.text, /ajoutée à MEMORY\.md/)
  assert.equal(
    await readFile(join(memoryDir, 'MEMORY.md'), 'utf8'),
    '- [port-du-serveur](port-du-serveur.md) — Le serveur de dev écoute sur 4242\n',
  )
  // Réécrire une note déjà indexée ne double pas sa ligne.
  mcp('write_memory', { file: 'port-du-serveur.md', content: NOTE.replace('4242.', '4243.') })
  assert.equal((await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')).split('\n').filter(Boolean).length, 1)
  assert.match(mcp('read_memory', { file: 'port-du-serveur.md' }).text, /4243/)
  assert.match(mcp('read_memory').text, /Notes : port-du-serveur\.md/)

  assert.equal(mcp('delete_memory', { file: 'port-du-serveur.md' }).isError, undefined)
  assert.equal(mcp('delete_memory', { file: 'port-du-serveur.md' }).isError, true)
  assert.equal((await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')).trim(), '')
})

test('Codex : l’index et le dossier en début de session', async (t) => {
  const { memoryDir, memory } = await harness(t)
  await memory()
  assert.equal(memoryAppendixForCodex(memoryDir, false), null)
  assert.match(memoryAppendixForCodex(memoryDir, true) ?? '', /encore vide[\s\S]*write_memory/)

  await writeFile(join(memoryDir, 'MEMORY.md'), '- [Port](port.md) — 4242\n')
  const text = memoryAppendixForCodex(memoryDir, false) ?? ''
  assert.match(text, /# Mémoire du projet/)
  assert.ok(text.includes(memoryDir))
  assert.match(text, /- \[Port\]\(port\.md\) — 4242/)
  assert.doesNotMatch(text, /write_memory/)
})
