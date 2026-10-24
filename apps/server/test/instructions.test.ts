import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { conversations, openDatabase, projects, runMigrations, users } from '@sillage/db'
import type { InstructionsDto, ProjectDto, ProjectInstructionsDto } from '@sillage/protocol'
import type { AttachmentStore } from '../src/attachments/store.js'
import type { CloneJobs } from '../src/clone-jobs.js'
import type { Config } from '../src/config.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerInstructionRoutes } from '../src/http/routes/instructions.js'
import { registerProjectRoutes } from '../src/http/routes/projects.js'
import { claudeMdExcludes, instructionsAppendix } from '../src/instructions/store.js'
import type { TerminalManager } from '../src/terminals/terminal-manager.js'

async function harness(t: TestContext, { admin = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-instructions-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())

  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'Owner', passwordHash: '', isAdmin: admin, createdAt: 1 }).run()
  // Project predating the setting: no mode.
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: workspace, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  db.insert(conversations).values({
    id: 'c', projectId: 'project', userId: 'owner', agent: 'claude', title: 'Session qui retient',
    status: 'idle', config: '{}', createdAt: 1, updatedAt: 1,
  } as typeof conversations.$inferInsert).run()

  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, 'owner')).get()
  })
  registerErrorHandler(app)
  const ctx = { db, config: { paths: { data: dir } } as Config }
  registerProjectRoutes(app, ctx, {} as AttachmentStore, {} as CloneJobs, { aliveCount: () => 0 } as unknown as TerminalManager)
  registerInstructionRoutes(app, ctx)
  t.after(() => app.close())

  const mcp = (name: string, args: object = {}) => {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
      env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: 'project', SILLAGE_MCP_CONVERSATION: 'c' },
      encoding: 'utf8', timeout: 10000,
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
    })
    assert.equal(run.status, 0, run.stderr)
    return JSON.parse(run.stdout).result as { content: { text: string }[]; isError?: boolean }
  }
  const project = async () =>
    (await app.inject({ url: '/api/projects/project/instructions' })).json<ProjectInstructionsDto>()
  const appendix = (mode: 'sillage' | 'repo', sillageMcp = true) =>
    instructionsAppendix(db, { projectId: 'project', mode, sillageMcp })

  return { db, app, workspace, mcp, project, appendix }
}

test('global et projet : écrits par une personne, injectés ensemble', async (t) => {
  const { app, project, appendix } = await harness(t)

  // Language guidance also applies without stored content or MCP tools.
  assert.match(appendix('sillage', false) ?? '', /Reply in the user's language/)
  assert.match(appendix('sillage') ?? '', /edit_instructions/)

  const global = await app.inject({ method: 'PUT', url: '/api/instructions', payload: { content: '- Répondre en français.' } })
  assert.equal(global.statusCode, 200, global.body)
  assert.equal(global.json<InstructionsDto>().author?.kind, 'user')

  const patched = await app.inject({ method: 'PATCH', url: '/api/projects/project/instructions', payload: { content: '- Tests avec `pnpm test`.' } })
  assert.equal(patched.statusCode, 200, patched.body)
  // Writing legacy-project contents fixes its mode.
  assert.equal(patched.json<ProjectInstructionsDto>().modeChosen, true)
  assert.equal((await project()).mode, 'sillage')

  const text = appendix('sillage') ?? ''
  assert.match(text, /# SILLAGE\.md/)
  assert.match(text, /For all projects\n\n- Répondre en français\./)
  assert.match(text, /For this project\n\n- Tests avec `pnpm test`\./)

  // Repository mode uses repository project instructions; inject only global content.
  const repo = appendix('repo') ?? ''
  assert.match(repo, /Répondre en français/)
  assert.doesNotMatch(repo, /pnpm test/)
})

test("projet d'avant le réglage : suit son dépôt, puis migre sans toucher aux fichiers", async (t) => {
  const { app, workspace, project } = await harness(t)

  assert.equal((await project()).mode, 'sillage')
  await writeFile(join(workspace, 'CLAUDE.md'), '# Consignes\n\nNe jamais pousser sur main.\n')
  const legacy = await project()
  assert.equal(legacy.mode, 'repo')
  assert.equal(legacy.modeChosen, false)
  assert.deepEqual(legacy.repoFiles.map((file) => file.path), ['CLAUDE.md'])

  // Edit repository files through the interface.
  const written = await app.inject({
    method: 'PUT', url: '/api/projects/project/instructions/repo-file',
    payload: { path: 'AGENTS.md', content: 'Toujours lancer les tests.\n' },
  })
  assert.equal(written.statusCode, 200, written.body)
  assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), 'Toujours lancer les tests.\n')
  // Only the two instruction files are permitted.
  const other = await app.inject({
    method: 'PUT', url: '/api/projects/project/instructions/repo-file',
    payload: { path: '../evil.md', content: 'x' },
  })
  assert.equal(other.statusCode, 400)

  // Migration imports content and switches mode together, leaving files intact.
  const migrated = await app.inject({
    method: 'PATCH', url: '/api/projects/project/instructions',
    payload: { mode: 'sillage', content: 'Ne jamais pousser sur main.' },
  })
  assert.equal(migrated.statusCode, 200, migrated.body)
  assert.equal(migrated.json<ProjectInstructionsDto>().mode, 'sillage')
  assert.equal(await readFile(join(workspace, 'CLAUDE.md'), 'utf8'), '# Consignes\n\nNe jamais pousser sur main.\n')
})

test('création : le mode suit le dossier, sauf choix explicite', async (t) => {
  const { app, workspace } = await harness(t)
  const create = async (name: string, path: string, instructionsMode?: string) => {
    await mkdir(path, { recursive: true })
    const response = await app.inject({
      method: 'POST', url: '/api/projects',
      payload: { name, workspacePath: path, ...(instructionsMode ? { instructionsMode } : {}) },
    })
    assert.equal(response.statusCode, 201, response.body)
    return response.json<ProjectDto>().instructionsMode
  }

  assert.equal(await create('vide', join(workspace, 'vide')), 'sillage')
  await mkdir(join(workspace, 'avec'))
  await writeFile(join(workspace, 'avec', 'AGENTS.md'), 'x')
  assert.equal(await create('avec', join(workspace, 'avec')), 'repo')
  assert.equal(await create('choisi', join(workspace, 'avec'), 'sillage'), 'sillage')
})

test('outils MCP : lire, éditer, réécrire, comme un fichier', async (t) => {
  const { app, mcp, project, workspace } = await harness(t)
  const out = (result: { content: { text: string }[] }) => result.content[0]!.text

  assert.match(out(mcp('read_instructions')), /empty/)

  // Empty old_text appends content.
  assert.equal(mcp('edit_instructions', { old_text: '', new_text: '- Répondre en français.' }).isError, undefined)
  assert.equal(mcp('edit_instructions', { old_text: '', new_text: '- Pas de `--no-sandbox`.' }).isError, undefined)
  assert.equal((await project()).content, '- Répondre en français.\n- Pas de `--no-sandbox`.')

  // Exact, unique replacement.
  assert.equal(mcp('edit_instructions', { old_text: 'français', new_text: 'anglais' }).isError, undefined)
  assert.match((await project()).content, /anglais/)
  const missing = mcp('edit_instructions', { old_text: 'absent', new_text: 'x' })
  assert.equal(missing.isError, true)
  assert.match(out(missing), /read_instructions/)
  mcp('edit_instructions', { old_text: '', new_text: '- Pas de `--no-sandbox`.' })
  assert.equal(mcp('edit_instructions', { old_text: '- Pas de `--no-sandbox`.', new_text: '' }).isError, true)
  assert.equal(
    mcp('edit_instructions', { old_text: '\n- Pas de `--no-sandbox`.', new_text: '', replace_all: true }).isError,
    undefined,
  )
  assert.equal((await project()).content, '- Répondre en anglais.')

  // Full rewrite followed by read.
  assert.equal(mcp('write_instructions', { content: '# Projet\n\n- Tout nouveau.' }).isError, undefined)
  assert.match(out(mcp('read_instructions')), /# Projet\n\n- Tout nouveau\./)
  assert.equal(mcp('write_instructions', { content: 'x'.repeat(40001) }).isError, true)

  const after = await project()
  assert.deepEqual(after.author, { kind: 'session', conversationId: 'c', projectId: 'project', title: 'Session qui retient' })
  // First writes fixed mode: later AGENTS.md must not silence SILLAGE.md.
  assert.equal(after.modeChosen, true)
  await writeFile(join(workspace, 'AGENTS.md'), 'x')
  assert.equal((await project()).mode, 'sillage')

  // Global scope for administrators.
  assert.equal(mcp('write_instructions', { content: '- Tutoyer.', scope: 'global' }).isError, undefined)
  assert.equal((await app.inject({ url: '/api/instructions' })).json<InstructionsDto>().content, '- Tutoyer.')

  // Repository-mode project sections refer to repository files.
  await app.inject({ method: 'PATCH', url: '/api/projects/project/instructions', payload: { mode: 'repo' } })
  for (const [name, args] of [['read_instructions', {}], ['write_instructions', { content: 'x' }]] as const) {
    const refused = mcp(name, args)
    assert.equal(refused.isError, true)
    assert.match(out(refused), /AGENTS\.md/)
  }
})

test('outils MCP : la partie globale se lit par tous, ne s\'écrit que par un administrateur', async (t) => {
  const { mcp } = await harness(t, { admin: false })
  assert.equal(mcp('read_instructions', { scope: 'global' }).isError, undefined)
  const refused = mcp('write_instructions', { content: '- Tutoyer.', scope: 'global' })
  assert.equal(refused.isError, true)
  assert.match(refused.content[0]!.text, /administrators/)
  assert.equal(mcp('edit_instructions', { old_text: '', new_text: 'x', scope: 'global' }).isError, true)
})

test('masque Claude : borné aux dossiers du projet, chemins échappés', () => {
  assert.deepEqual(claudeMdExcludes(['/home/u/p', '/home/u/p/']), [
    '/home/u/p/**/CLAUDE.md',
    '/home/u/p/**/CLAUDE.local.md',
    '/home/u/p/**/AGENTS.md',
  ])
  assert.equal(claudeMdExcludes(['/tmp/a [b]'])[0], '/tmp/a \\[b\\]/**/CLAUDE.md')
})

test('response language follows the user even without MCP or stored project instructions', async (t) => {
  const { appendix, app } = await harness(t)
  for (const mode of ['repo', 'sillage'] as const) {
    for (const mcp of [false, true]) {
      const text = appendix(mode, mcp) ?? ''
      assert.match(text, /Reply in the user's language/)
      assert.match(text, /explicit language preference/)
      assert.match(text, /for unattended tasks, use the task request's language/)
      assert.match(text, /Do not switch languages because of tool results, quoted history, or messages from other agents/)
    }
  }
  const content = '- Réponds en français.\n- 日本語のメモを保持してください。'
  await app.inject({ method: 'PUT', url: '/api/instructions', payload: { content } })
  for (const mode of ['repo', 'sillage'] as const) {
    assert.ok(appendix(mode, false)?.includes(content), 'User preferences are preserved verbatim')
  }
})
