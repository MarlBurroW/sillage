import assert from 'node:assert/strict'

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { conversationHandoffs, conversationProjectMoves, conversations, events, openDatabase, projects, runMigrations, users } from '@sillage/db'
import { defaultConfigFor, agentKindSchema } from '@sillage/protocol'
import { AgentRegistry, type AgentAdapter } from '../src/agents/registry.js'
import type { AgentRunner, RunnerContext } from '../src/agents/types.js'
import { loadConfig } from '../src/config.js'
import { pendingProjectMove, requestProjectMove } from '../src/conversations/project-transfer.js'
import { EventLog } from '../src/events/event-log.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerConversationRoutes } from '../src/http/routes/conversations.js'
import { registerFileRoutes } from '../src/http/routes/files.js'
import { AgentRequests } from '../src/sessions/agent-requests.js'
import { SessionManager } from '../src/sessions/session-manager.js'
import { workspaceImagePath } from '../src/workspace-images.js'

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(check(), 'Condition did not settle')
}

async function harness(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sillage-project-transfer-'))
  const dbPath = join(root, 'test.db')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  for (const id of ['owner', 'member', 'admin']) db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', isAdmin: id === 'admin', createdAt: 1 }).run()
  for (const [id, ownerId, visibility] of [['source', 'owner', 'shared'], ['target', 'owner', 'private'], ['shared', 'member', 'shared'], ['hidden', 'admin', 'private']] as const) {
    await mkdir(join(root, id))
    db.insert(projects).values({ id, name: id, ownerId, visibility, workspacePath: join(root, id), instructionsMode: 'repo', memoryMode: 'native', turnCheckpoints: false, createdAt: 1 }).run()
    await writeFile(join(root, id, 'AGENTS.md'), id + ' instructions')
  }
  const config = loadConfig()
  config.paths = { ...config.paths, data: root, database: dbPath, agents: join(root, 'agents'), memory: join(root, 'memory'), skillLibrary: join(root, 'skills') }
  config.skills.library = false
  const contexts: RunnerContext[] = []
  const sent: string[] = []
  let stops = 0
  const registry = new AgentRegistry(agentKindSchema.options.map(kind => ({
    kind, label: kind, binary: 'sillage-test-no-cli', rawFormat: 'test',
    cli: { managedDir: config.paths.agents, assertEnabled() {} },
    createRunner(context: RunnerContext) {
      contexts.push(context)
      return {
        appliedConfig: context.config,
        async start() { context.setAgentSessionId('native-' + contexts.length) },
        async send(text: string) { sent.push(text); context.setStatus('running') },
        async stop() { stops++ },
      } as AgentRunner
    },
  } as unknown as AgentAdapter)))
  const log = new EventLog(db)
  const manager = () => new SessionManager(db, log, config, registry, {} as never, {} as never, {} as never, {} as never, { homes: { sessions: () => join(root, 'antigravity') } } as never)
  const sessions = manager()
  const create = (id = 'session', userId = 'owner', agent = 'codex' as typeof agentKindSchema.options[number]) => {
    db.insert(conversations).values({ id, projectId: 'source', userId, agent, config: JSON.stringify(defaultConfigFor(agent)), title: id, status: 'idle', createdAt: 1, updatedAt: 1 }).run()
    return id
  }
  create()
  const ctx = { db, config }
  const app = Fastify()
  app.addHook('preHandler', async request => { request.user = db.select().from(users).where(eq(users.id, String(request.headers['x-user'] ?? 'owner'))).get() })
  registerErrorHandler(app)
  registerConversationRoutes(app, ctx, log, sessions, registry, {} as never, {} as never)
  registerFileRoutes(app, ctx)
  const requests = new AgentRequests(ctx, sessions, registry, undefined, undefined, undefined, undefined, log)
  const row = (id = 'session') => db.select().from(conversations).where(eq(conversations.id, id)).get()!
  const mcp = async (name: string, args = {}) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
      env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: row().projectId!, SILLAGE_MCP_CONVERSATION: 'session' },
    })
    let output = '', errors = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { errors += String(chunk) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n')
    try {
      for (let i = 0; i < 200 && !output.includes('\n'); i++) { await requests.sweep(); await new Promise(resolve => setTimeout(resolve, 10)) }
      assert.ok(output, errors)
      return JSON.parse(output).result as { isError?: boolean; content: { text: string }[] }
    } finally { child.kill() }
  }
  t.after(async () => { await app.close(); await sessions.stopAll(); sqlite.close(); await rm(root, { recursive: true, force: true }) })
  return { root, db, log, sessions, contexts, sent, row, app, mcp, create, manager, stops: () => stops }
}

test('moves preserve the same journal and resume every CLI with the destination cwd and portable context', async t => {
  const h = await harness(t)
  for (const agent of agentKindSchema.options) {
    const id = h.create(agent, 'owner', agent)
    const expected = h.sent.length + 1
    await h.sessions.sendMessage(id, 'first-' + agent, 'Keep the warm beige office')
    await until(() => h.sent.length === expected)
    const previous = h.contexts.at(-1)!
    previous.emit({ type: 'message.completed', messageId: agent, role: 'assistant', parentToolCallId: null, blocks: [{ type: 'text', text: 'The office is painted; next fix the niche.' }] })
    previous.setStatus('idle')
    const before = h.db.select().from(events).where(eq(events.conversationId, id)).all()
    await h.sessions.moveToProject(id, 'owner', 'target')
    assert.equal(h.row(id).id, id)
    assert.equal(h.row(id).projectId, 'target')
    assert.equal(h.row(id).agentSessionId, null)
    assert.deepEqual(h.db.select().from(events).where(eq(events.conversationId, id)).all().slice(0, before.length), before)
    const context = h.db.select().from(conversationHandoffs).where(eq(conversationHandoffs.conversationId, id)).get()!.text
    assert.match(context, /warm beige office/)
    assert.match(context, /next fix the niche/)
    assert.match(context, /now belongs to “target”/)
    await h.sessions.sendMessage(id, 'next-' + agent, 'Continue the niche')
    await until(() => h.contexts.at(-1) !== previous)
    const next = h.contexts.at(-1)!
    assert.equal(next.cwd, join(h.root, 'target'))
    assert.equal(next.resumeSessionId, null)
    assert.match(next.projectOverview(next.config)!, /warm beige office/)
    assert.match(next.projectOverview(next.config)!, /now belongs to “target”/)
    await until(() => h.sent.length === h.contexts.length)
    next.setStatus('idle')
  }
})

test('agent move waits for the final answer, keeps queued messages and exposes only accessible destination projects', async t => {
  const h = await harness(t)
  await h.sessions.sendMessage('session', 'first', 'Paint the office')
  await until(() => h.sent.length === 1)
  const source = h.contexts[0]!
  const projects = (await h.mcp('list_projects')).content[0]!.text
  assert.match(projects, /target/)
  assert.doesNotMatch(projects, /hidden/)
  const result = await h.mcp('move_session', { project: 'target' })
  assert.equal(result.isError, undefined, result.content[0]?.text)
  assert.match(result.content[0]!.text, /Finish this turn/)
  assert.equal(h.row().projectId, 'source')
  assert.equal(h.stops(), 0)
  await h.sessions.sendMessage('session', 'queued', 'Now finish the niche')
  source.emit({ type: 'message.completed', messageId: 'final', role: 'assistant', parentToolCallId: null, blocks: [{ type: 'text', text: 'Final instruction: paint only inside the niche.' }] })
  source.setStatus('idle')
  await until(() => h.sent.length === 2)
  assert.deepEqual(h.sent, ['Paint the office', 'Now finish the niche'])
  assert.equal(h.row().projectId, 'target')
  assert.equal(h.contexts[1]!.cwd, join(h.root, 'target'))
  assert.match(h.contexts[1]!.projectOverview(h.contexts[1]!.config)!, /paint only inside the niche/)
  assert.equal(h.stops(), 1)
})

test('ownership and project access apply equally to UI and agents, without admin privilege', async t => {
  const h = await harness(t)
  const move = (user: string, project: string) => h.app.inject({ method: 'POST', url: '/api/conversations/session/move', headers: { 'x-user': user }, payload: { project } })
  assert.equal((await move('admin', 'target')).statusCode, 403)
  assert.equal((await move('member', 'shared')).statusCode, 403)
  assert.equal((await move('owner', 'hidden')).statusCode, 404)
  assert.equal((await h.mcp('move_session', { project: 'hidden' })).isError, true)
  assert.equal((await move('owner', 'source')).statusCode, 400)
  assert.equal((await move('owner', 'shared')).statusCode, 200, 'a member can move their own session into a shared project')
  assert.equal(h.row().projectId, 'shared')
  h.db.update(projects).set({ archivedAt: 1 }).where(eq(projects.id, 'target')).run()
  assert.equal((await move('owner', 'target')).statusCode, 404)
})

test('pending moves survive recovery, reject lost access, and never apply twice', async t => {
  const h = await harness(t)
  await requestProjectMove(h.db, 'session', 'owner', 'target')
  await requestProjectMove(h.db, 'session', 'owner', 'target')
  assert.equal(h.db.select().from(conversationProjectMoves).all().length, 1)
  await assert.rejects(requestProjectMove(h.db, 'session', 'owner', 'shared'), { code: 'project_move_pending' })
  const recovered = h.manager()
  await recovered.applyPendingProjectMoves()
  assert.equal(h.row().projectId, 'target')
  assert.equal(pendingProjectMove(h.db, 'session'), undefined)
  await recovered.applyPendingProjectMoves()
  assert.equal(h.db.select().from(conversationProjectMoves).all().length, 1)
  h.create('other')
  await requestProjectMove(h.db, 'other', 'owner', 'shared')
  h.db.update(projects).set({ visibility: 'private' }).where(eq(projects.id, 'shared')).run()
  await recovered.applyPendingProjectMoves()
  assert.equal(h.row('other').projectId, 'source')
  assert.ok(h.db.select().from(conversationProjectMoves).all().find(move => move.conversationId === 'other')?.error)
})

test('old screenshots stay readable, old checkpoints cannot restore into the new project, and stale editors cannot overwrite it', async t => {
  const h = await harness(t)
  const image = join(h.root, 'source', 'photo.png')
  await writeFile(image, 'photo')
  for (const project of ['source', 'target']) {
    await writeFile(join(h.root, project, 'same.txt'), 'same')
    await utimes(join(h.root, project, 'same.txt'), 100, 100)
  }
  const opened = (await h.app.inject('/api/conversations/session/file?path=same.txt')).json()
  h.log.append('session', { type: 'checkpoint.started', key: 'before-move' })
  await h.sessions.moveToProject('session', 'owner', 'target')
  assert.equal(await workspaceImagePath(h.db, join(h.root, 'target'), 'session', 'owner', image), image)
  await assert.rejects(h.sessions.restoreCheckpoint('session', 'before-move'), { code: 'checkpoint_previous_project' })
  const save = await h.app.inject({ method: 'PUT', url: '/api/conversations/session/file', payload: { path: 'same.txt', content: 'old draft', fingerprint: opened.fingerprint } })
  assert.equal(save.statusCode, 409, save.body)
  assert.equal(await readFile(join(h.root, 'target', 'same.txt'), 'utf8'), 'same')
  h.db.update(projects).set({ visibility: 'private', ownerId: 'admin' }).where(eq(projects.id, 'source')).run()
  await assert.rejects(workspaceImagePath(h.db, join(h.root, 'target'), 'session', 'owner', image), { code: 'file_not_found' })
})

test('forking a moved session respects the cut point without leaking later context', async t => {
  const h = await harness(t)
  h.log.append('session', { type: 'message.completed', messageId: 'first', role: 'user', parentToolCallId: null, blocks: [{ type: 'text', text: 'Original request' }] })
  const cut = h.row().lastSeq
  h.log.append('session', { type: 'message.completed', messageId: 'later', role: 'assistant', parentToolCallId: null, blocks: [{ type: 'text', text: 'Future choice to exclude' }] })
  await h.sessions.moveToProject('session', 'owner', 'target')
  const response = await h.app.inject({ method: 'POST', url: '/api/conversations/session/fork', payload: { throughSeq: cut } })
  assert.equal(response.statusCode, 201, response.body)
  const fork = response.json()
  const context = h.db.select().from(conversationHandoffs).where(eq(conversationHandoffs.conversationId, fork.id)).get()!.text
  assert.match(context, /Original request/)
  assert.doesNotMatch(context, /Future choice to exclude/)
  assert.equal(fork.projectId, 'target')
  assert.equal(h.row(fork.id).agentSessionId, null)
})

test('a move also waits for questions, detached tasks and armed loops', async t => {
  const h = await harness(t)
  await h.sessions.sendMessage('session', 'first', 'Work')
  await until(() => h.sent.length === 1)
  const context = h.contexts[0]!
  context.setStatus('awaiting_input')
  assert.equal((await h.sessions.moveToProject('session', 'owner', 'target')).pending, true)
  context.emit({ type: 'background.updated', tasks: [{ id: 'background' }] } as never)
  context.setStatus('idle')
  await h.sessions.applyPendingProjectMoves()
  assert.equal(h.stops(), 0)
  context.emit({ type: 'loops.updated', loops: [{ id: 'loop' }] } as never)
  context.emit({ type: 'background.updated', tasks: [] })
  await h.sessions.applyPendingProjectMoves()
  assert.equal(h.stops(), 0)
  context.emit({ type: 'loops.updated', loops: [] })
  await h.sessions.applyPendingProjectMoves()
  assert.equal(h.stops(), 1)
  assert.equal(h.row().projectId, 'target')
})
