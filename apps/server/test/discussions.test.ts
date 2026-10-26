import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { conversationHandoffs, conversations, openDatabase, personalWorkspaces, projects, runMigrations, users } from '@sillage/db'
import { conversationPath, defaultConfigFor, sessionReferenceRanges, type AgentConfig, type ConversationDto, type PersonalMemoryDto, type PersonalWorkspaceDto } from '@sillage/protocol'
import type { AgentRegistry } from '../src/agents/registry.js'
import type { AttachmentStore } from '../src/attachments/store.js'
import { EventLog } from '../src/events/event-log.js'
import type { AppContext } from '../src/http/context.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { canReadConversation, registerConversationRoutes } from '../src/http/routes/conversations.js'
import { registerDiscussionRoutes } from '../src/http/routes/discussions.js'
import { registerInstructionRoutes } from '../src/http/routes/instructions.js'
import { registerTreeRoutes } from '../src/http/routes/tree.js'
import { readPersonalMemory, writePersonalMemory } from '../src/memory/personal.js'
import { searchMessages } from '../src/search/search-messages.js'
import { AgentRequests } from '../src/sessions/agent-requests.js'
import type { SessionManager } from '../src/sessions/session-manager.js'
import type { TerminalManager } from '../src/terminals/terminal-manager.js'
import type { WebhookService } from '../src/webhooks/service.js'
import { conversationWorkspace } from '../src/workspace.js'

const migrations = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url))
async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-discussions-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, migrations)
  t.after(() => sqlite.close())
  for (const id of ['owner', 'other']) db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', isAdmin: id === 'other', createdAt: 1 }).run()
  const ctx = { db, config: { paths: { data: dir, memory: join(dir, 'memory'), skillLibrary: join(dir, 'skills'), worktrees: join(dir, 'worktrees') } } } as AppContext
  const sent: string[] = []
  const sessions = { statusBus: new EventEmitter(), async sendMessage(id: string) { sent.push(id) }, async terminate() {}, async dropCheckpoints() {}, async reloadConfig() {} } as unknown as SessionManager
  const registry = { adapter: () => ({ resolveDefaults: async (config: AgentConfig) => config }) } as unknown as AgentRegistry
  const attachments = { claim() {}, async removeForConversations() {}, async removeForCards() {} } as unknown as AttachmentStore
  const terminals = { async closeForProject() {} } as unknown as TerminalManager
  const log = new EventLog(db)
  const requests = new AgentRequests(ctx, sessions, registry, undefined, undefined, undefined, undefined, log, undefined, attachments, terminals)
  const app = Fastify()
  app.addHook('preHandler', async request => { request.user = db.select().from(users).where(eq(users.id, String(request.headers['x-user'] ?? 'owner'))).get() })
  registerErrorHandler(app)
  registerConversationRoutes(app, ctx, log, sessions, registry, attachments, {} as WebhookService)
  registerDiscussionRoutes(app, ctx)
  registerTreeRoutes(app, ctx)
  registerInstructionRoutes(app, ctx)
  t.after(() => app.close())
  const create = async (user = 'owner') => {
    const response = await app.inject({ method: 'POST', url: '/api/discussions', headers: { 'x-user': user }, payload: { agent: 'codex', config: defaultConfigFor('codex'), title: `Private ${user}` } })
    assert.equal(response.statusCode, 201, response.body)
    return response.json<ConversationDto>()
  }
  const mcp = async (source: string, name: string, args: object = {}) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
      env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: '', SILLAGE_MCP_PERSONAL: '1', SILLAGE_MCP_CONVERSATION: source, SILLAGE_MCP_MEMORY_ROOT: ctx.config.paths.memory, SILLAGE_MCP_USER: 'other' },
    })
    let output = '', errors = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { errors += chunk.toString() })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: name === 'tools/list' ? name : 'tools/call', params: { name, arguments: args } }) + '\n')
    try {
      const deadline = Date.now() + 10000
      while (!output.includes('\n') && Date.now() < deadline && child.exitCode === null) { await requests.sweep(); await new Promise(resolve => setTimeout(resolve, 20)) }
      assert.ok(output, errors || `No MCP response for ${name}`)
      return JSON.parse(output).result as { isError?: boolean; content: { text: string }[]; tools?: { name: string }[] }
    } finally { child.kill() }
  }
  return { app, ctx, db, sqlite, dir, log, create, mcp, sent }
}

test('personal discussions isolate lists, transcripts, search, folders and memory, including from other admins', async t => {
  const { app, ctx, create, log } = await harness(t)
  const own = await create(), other = await create('other')
  assert.equal(own.projectId, null)
  assert.notEqual(conversationWorkspace(ctx.db, own.id, 'owner'), conversationWorkspace(ctx.db, other.id, 'other'))
  assert.equal(canReadConversation(ctx, own.id, 'other'), false)
  for (const id of [own.id, other.id]) log.append(id, { type: 'message.completed', messageId: id, role: 'user', parentToolCallId: null, blocks: [{ type: 'text', text: 'private astronomy notes' }] })
  assert.deepEqual(searchMessages(ctx.db, 'owner', 'astronomy', 10).map(row => row.conversationId), [own.id])
  const listed = (await app.inject('/api/conversations')).json<ConversationDto[]>()
  assert.deepEqual(listed.map(row => row.id), [own.id])
  for (const suffix of ['', '/events', '/tree']) {
    const response = await app.inject({ url: `/api/conversations/${own.id}${suffix}`, headers: { 'x-user': 'other' } })
    assert.equal(response.statusCode, 404, response.body)
  }
  const saved = await app.inject({ method: 'PUT', url: '/api/me/memory/preference.md', payload: { content: 'Keep French replies.' } })
  assert.equal(saved.statusCode, 204, saved.body)
  const memory = (await app.inject('/api/me/memory')).json<PersonalMemoryDto>()
  assert.equal(memory.files.find(file => file.file === 'preference.md')?.content, 'Keep French replies.')
  assert.equal((await app.inject({ url: '/api/me/memory', headers: { 'x-user': 'other' } })).json<PersonalMemoryDto>().files.length, 0)
  const workspace = (await app.inject('/api/discussions/workspaces')).json<PersonalWorkspaceDto[]>()[0]!
  assert.equal((await app.inject({ url: `/api/personal-workspaces/${workspace.id}/tree`, headers: { 'x-user': 'other' } })).statusCode, 404)
})

test('deleting a discussion retains its files, which can only be deleted separately when unused', async t => {
  const { app, create } = await harness(t)
  const session = await create()
  const workspace = (await app.inject('/api/discussions/workspaces')).json<PersonalWorkspaceDto[]>()[0]!
  await writeFile(join(workspace.path, 'idea.md'), 'Keep this idea')
  const remove = () => app.inject({ method: 'DELETE', url: `/api/personal-workspaces/${workspace.id}` })
  assert.equal((await remove()).statusCode, 409)
  const deleted = await app.inject({ method: 'DELETE', url: `/api/conversations/${session.id}` })
  assert.equal(deleted.statusCode, 204, deleted.body)
  assert.equal(await readFile(join(workspace.path, 'idea.md'), 'utf8'), 'Keep this idea')
  assert.deepEqual((await app.inject('/api/discussions/workspaces')).json<PersonalWorkspaceDto[]>()[0]?.conversations, [])
  assert.equal((await app.inject(`/api/personal-workspaces/${workspace.id}/tree`)).statusCode, 200)
  assert.equal((await remove()).statusCode, 204)
  await assert.rejects(stat(workspace.path), { code: 'ENOENT' })
})

test('project continuation copies only reviewed context and selected files, with private source ownership preserved', async t => {
  const { app, create, ctx, dir, db } = await harness(t)
  const source = await create()
  const root = conversationWorkspace(db, source.id, 'owner')
  await mkdir(join(root, 'notes'))
  await writeFile(join(root, 'notes/idea.md'), 'Chosen idea')
  await writeFile(join(root, 'secret.md'), 'Private thoughts')
  await symlink(join(root, 'secret.md'), join(root, 'link.md'))
  const transfer = (files: string[]) => app.inject({ method: 'POST', url: `/api/conversations/${source.id}/project`, payload: { project: { name: 'Project', parentDir: dir, directory: 'project', visibility: 'shared' }, brief: 'Approved brief', files } })
  assert.equal((await transfer(['../test.sqlite'])).statusCode, 400)
  assert.equal((await transfer(['link.md'])).statusCode, 400)
  const response = await transfer(['notes/idea.md'])
  assert.equal(response.statusCode, 201, response.body)
  const destination = response.json<ConversationDto>()
  assert.ok(destination.projectId)
  assert.equal(destination.handoffFromId, source.id)
  assert.equal(db.select().from(conversations).where(eq(conversations.id, source.id)).get()?.projectId, null)
  assert.equal(await readFile(join(dir, 'project/notes/idea.md'), 'utf8'), 'Chosen idea')
  await assert.rejects(stat(join(dir, 'project/secret.md')), { code: 'ENOENT' })
  const brief = db.select().from(conversationHandoffs).where(eq(conversationHandoffs.conversationId, destination.id)).get()!.text
  assert.match(brief, /Approved brief/)
  assert.doesNotMatch(brief, /Private thoughts/)
  assert.equal(canReadConversation(ctx, destination.id, 'other'), true)
  assert.equal(canReadConversation(ctx, source.id, 'other'), false)
  assert.equal((await app.inject({ url: `/api/conversations/${destination.id}/handoff`, headers: { 'x-user': 'other' } })).json().text, brief)
})

test('memory changes are ordered and audited for concurrent writes and filesystem edits', async t => {
  const { db, dir } = await harness(t)
  const root = join(dir, 'notes')
  await mkdir(root)
  await Promise.all(['first', 'second', 'third'].map(content => writePersonalMemory(db, root, 'owner', 'idea.md', content, 'discussion')))
  await writeFile(join(root, 'idea.md'), 'CLI edit')
  const memory = await readPersonalMemory(db, root, 'owner', 'discussion')
  const changes = memory.changes.filter(change => change.file === 'idea.md')
  assert.deepEqual(changes.map(change => change.after), ['CLI edit', 'third', 'second', 'first'])
  assert.deepEqual(changes.map(change => change.before), ['third', 'second', 'first', null])
  await writePersonalMemory(db, root, 'owner', 'idea.md', null)
  assert.equal((await readPersonalMemory(db, root, 'owner')).changes[0]?.after, null)
})

test('personal MCP resolves its account from the session, and creates, searches, remembers and deletes projects', async t => {
  const { create, mcp, dir, db } = await harness(t)
  const session = await create()
  const other = await create('other')
  const listing = await mcp(session.id, 'tools/list')
  for (const name of ['create_project', 'continue_in_project', 'delete_project', 'find_files', 'write_memory', 'rename_session', 'list_projects']) assert.ok(listing.tools?.some(tool => tool.name === name), name)
  assert.equal((await mcp(session.id, 'read_conversation', { id: other.id })).isError, true)
  assert.equal((await mcp(session.id, 'write_memory', { file: 'idea.md', content: 'Reusable preference' })).isError, undefined)
  assert.match((await mcp(session.id, 'read_memory', { file: 'idea.md' })).content[0]!.text, /Reusable preference/)
  const created = await mcp(session.id, 'create_project', { name: 'Idea', parentDir: dir, directory: 'idea' })
  assert.equal(created.isError, undefined, created.content[0]?.text)
  const project = db.select().from(projects).get()!
  assert.equal(project.ownerId, 'owner')
  await writeFile(join(project.workspacePath, 'notebook.md'), 'hello')
  const found = await mcp(session.id, 'find_files', { query: 'notebook' })
  assert.match(found.content[0]!.text, /notebook.md/)
  const deleted = await mcp(session.id, 'delete_project', { project: project.id })
  assert.equal(deleted.isError, undefined, deleted.content[0]?.text)
  assert.equal(db.select().from(projects).get(), undefined)
  assert.equal(await readFile(join(project.workspacePath, 'notebook.md'), 'utf8'), 'hello')
  assert.equal(db.select().from(personalWorkspaces).all().length, 2)
})

test('global instruction edits never reveal a personal source title to another account', async t => {
  const { app, create, mcp } = await harness(t)
  const admin = await create('other')
  assert.equal((await mcp(admin.id, 'write_instructions', { scope: 'global', content: 'Be concise.' })).isError, undefined)
  const own = (await app.inject({ url: '/api/instructions', headers: { 'x-user': 'other' } })).json()
  assert.equal(own.author.title, admin.title)
  const external = (await app.inject('/api/instructions')).json()
  assert.equal(external.author.kind, 'user')
  assert.doesNotMatch(JSON.stringify(external), new RegExp(admin.title))
})

test('migration preserves conversations, journals and related rows while making the project optional', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-discussion-migration-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const before = join(dir, 'before')
  await cp(migrations, before, { recursive: true })
  const journalPath = join(before, 'meta/_journal.json')
  const journal = JSON.parse(await readFile(journalPath, 'utf8'))
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 56)
  await writeFile(journalPath, JSON.stringify(journal))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  t.after(() => sqlite.close())
  runMigrations(db, before)
  sqlite.exec("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES('u','u','u','',1); INSERT INTO projects(id,name,workspace_path,owner_id,visibility,created_at) VALUES('p','p','/unused','u','private',1); INSERT INTO conversations(id,project_id,user_id,title,agent,config,status,created_at,updated_at) VALUES('c','p','u','c','codex','{}','idle',1,1)")
  const log = new EventLog(db)
  log.append('c', { type: 'message.completed', messageId: 'm', role: 'user', parentToolCallId: null, blocks: [{ type: 'text', text: 'Preserve me' }] })
  sqlite.exec("INSERT INTO conversation_reads(conversation_id,user_id,last_read_seq,updated_at) VALUES('c','u',1,1)")
  const events = sqlite.prepare('SELECT * FROM events').all()
  runMigrations(db, migrations)
  assert.deepEqual(sqlite.prepare('SELECT * FROM events').all(), events)
  assert.equal((sqlite.prepare('SELECT count(*) AS n FROM conversation_reads').get() as { n: number }).n, 1)
  assert.equal(db.select().from(conversations).get()?.workspaceId, null)
  assert.equal(db.select().from(conversations).get()?.projectId, 'p')
  assert.deepEqual(sqlite.pragma('foreign_key_check'), [])
  assert.equal(sqlite.pragma('foreign_keys', { simple: true }), 1)
  runMigrations(db, migrations)
  assert.deepEqual(sqlite.prepare('SELECT * FROM events').all(), events)
})

test('personal discussion links survive copy-paste as stable session references', () => {
  const id = 'ebdbd81f-a4bc-4142-ad8b-a236a54f128d'
  assert.equal(conversationPath({ id, projectId: null }), `/discussions/${id}`)
  for (const text of [`/discussions/${id}`, `https://sillage.test/discussions/${id}?view=files`]) assert.equal(sessionReferenceRanges(text, 'https://sillage.test')[0]?.id, id)
  assert.deepEqual(sessionReferenceRanges(`https://elsewhere.test/discussions/${id}`, 'https://sillage.test'), [])
})
