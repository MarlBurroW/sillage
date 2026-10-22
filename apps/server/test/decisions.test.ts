import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import {
  agentRequests,
  boardLinks,
  cardIssues,
  cardNotes,
  cards,
  conversations,
  decisions,
  openDatabase,
  projects,
  runMigrations,
  scheduledTasks,
  users,
} from '@sillage/db'
import { DEFAULT_BOARD_LINK_SETTINGS, type InAppNotification, type PushPayload } from '@sillage/protocol'
import type { AgentRegistry } from '../src/agents/registry.js'
import type { Config } from '../src/config.js'
import { DecisionService } from '../src/decisions/service.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerDecisionRoutes } from '../src/http/routes/decisions.js'
import { Notifications, type OutgoingNotification } from '../src/notifications/dispatcher.js'
import type { PushService } from '../src/push/push-service.js'
import { AgentRequests } from '../src/sessions/agent-requests.js'
import type { SessionManager } from '../src/sessions/session-manager.js'

const TASK_SESSION = '11111111-0000-4000-8000-000000000001'
const BOARD_SESSION = '11111111-0000-4000-8000-000000000002'
const HUMAN_SESSION = '11111111-0000-4000-8000-000000000003'

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-decisions-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())

  for (const id of ['owner', 'other']) db.insert(users).values({ id, username: id, displayName: id === 'owner' ? 'Nico' : 'Other', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'Nimbus', workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const now = Date.now()
  db.insert(scheduledTasks).values({
    id: 'task', projectId: 'project', userId: 'owner', name: 'Veille Codex', agent: 'claude', config: '{}', prompt: 'p',
    cadence: JSON.stringify({ kind: 'interval', minutes: 60 }), executionMode: 'fresh', overlapPolicy: 'skip', maxDurationMinutes: 30,
    enabled: true, createdAt: now, updatedAt: now,
  }).run()
  const conversation = (id: string, extra: Partial<typeof conversations.$inferInsert> = {}) =>
    db.insert(conversations).values({ id, projectId: 'project', userId: 'owner', title: `Session ${id.slice(-1)}`, agent: 'claude', config: '{}', status: 'idle', createdAt: now, updatedAt: now, ...extra }).run()
  conversation(TASK_SESSION, { scheduleId: 'task' })
  conversation(HUMAN_SESSION)
  db.insert(cards).values({ id: 'card', projectId: 'project', number: 7, title: 'Crash', column: 'todo', createdBy: 'owner', createdAt: now, updatedAt: now }).run()
  conversation(BOARD_SESSION, { cardId: 'card' })
  const { repo: _repo, sessionConfig: _config, ...linkSettings } = { repo: 'acme/app', ...DEFAULT_BOARD_LINK_SETTINGS }
  db.insert(boardLinks).values({ projectId: 'project', repo: 'acme/app', userId: 'owner', ...linkSettings, sessionConfig: null, createdAt: now, updatedAt: now }).run()
  db.insert(cardIssues).values({
    cardId: 'card', projectId: 'project', repo: 'acme/app', number: 42, url: 'https://github.com/acme/app/issues/42', title: 'Crash', state: 'open',
    remoteUpdatedAt: new Date().toISOString(), responderId: BOARD_SESSION,
  }).run()

  const sent: Array<{ to: string; text: string }> = []
  const sessions = { sendMessage: async (to: string, _id: string, text: string) => { sent.push({ to, text }) } } as unknown as SessionManager
  const dispatched: Array<{ userId: string; notification: OutgoingNotification }> = []
  const changed: string[] = []
  const notifications = {
    dispatch: async (userId: string, notification: OutgoingNotification) => { dispatched.push({ userId, notification }) },
    decisionsChanged: (userId: string) => { changed.push(userId) },
  }
  const ctx = { db, config: {} as Config }
  const service = new DecisionService(ctx, sessions, notifications)
  const requests = new AgentRequests(ctx, sessions, {} as AgentRegistry, undefined, undefined, undefined, service)
  const ask = async (conversationId: string, kind: 'request_decision' | 'withdraw_decision', payload: object) => {
    const id = randomUUID()
    db.insert(agentRequests).values({ id, projectId: 'project', conversationId, kind, payload: JSON.stringify(payload), createdAt: Date.now() }).run()
    await requests.sweep()
    return db.select().from(agentRequests).where(eq(agentRequests.id, id)).get()!
  }
  const tools = (conversationId: string) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
      env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: 'project', SILLAGE_MCP_CONVERSATION: conversationId },
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n',
      encoding: 'utf8',
      timeout: 10000,
    })
    assert.equal(result.status, 0, result.stderr)
    return (JSON.parse(result.stdout.trim().split('\n').pop()!) as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)
  }
  return { db, service, sent, dispatched, changed, ask, tools }
}

test('decisions: offered only to allowed autonomous sessions, one at a time, answered back as a message', async (t) => {
  const { db, service, sent, dispatched, ask, tools } = await harness(t)

  // Tools exist only where sources permit them.
  assert.ok(!tools(TASK_SESSION).includes('request_decision'), 'Off by default')
  assert.ok(!tools(HUMAN_SESSION).includes('request_decision'))
  db.update(scheduledTasks).set({ decisionsEnabled: true, decisionMaxHours: 12 }).run()
  db.update(boardLinks).set({ decisionsEnabled: true }).run()
  assert.ok(tools(TASK_SESSION).includes('request_decision'))
  assert.ok(tools(TASK_SESSION).includes('withdraw_decision'))
  assert.ok(tools(BOARD_SESSION).includes('request_decision'))
  assert.ok(!tools(HUMAN_SESSION).includes('request_decision'), 'A session opened by a person asks in the thread')

  // Reject human sessions and defaults absent from options.
  assert.equal((await ask(HUMAN_SESSION, 'request_decision', { question: 'Push?' })).isError, true)
  assert.equal((await ask(TASK_SESSION, 'request_decision', { question: 'Push?', options: ['Yes', 'No'], default: 'Maybe' })).isError, true)

  const asked = await ask(TASK_SESSION, 'request_decision', {
    question: 'Push the fix to main?',
    context: 'Tests pass, 3 files changed.',
    options: ['Yes', 'No', 'Yes'],
    default: 'No',
    expires_in_hours: 48,
  })
  assert.equal(asked.isError, false, asked.result ?? '')
  assert.match(asked.result ?? '', /Ne l'attends pas/)
  const row = db.select().from(decisions).get()!
  assert.deepEqual(JSON.parse(row.options), ['Yes', 'No'], 'Duplicate options are merged')
  assert.ok(row.expiresAt <= Date.now() + 12 * 3_600_000 + 1000, 'Capped by the source maximum')
  assert.equal(row.sourceKind, 'schedule')
  assert.equal(row.sourceLabel, 'Veille Codex')

  const announced = dispatched.at(-1)!
  assert.equal(announced.userId, 'owner')
  assert.equal(announced.notification.kind, 'decision')
  assert.equal(announced.notification.push.badge, 1)
  assert.deepEqual(announced.notification.toast, { kind: 'decision', decisionId: row.id, question: 'Push the fix to main?', sourceLabel: 'Veille Codex', sourceKind: 'schedule', projectName: 'Nimbus' })

  assert.equal((await ask(TASK_SESSION, 'request_decision', { question: 'Another one?' })).isError, true, 'One pending at a time')

  // Responses become session messages; decisions resolve and deliver.
  await assert.rejects(service.answer('owner', row.id, { option: 'Perhaps', text: '' }), /not offered/)
  const answered = await service.answer('owner', row.id, { option: 'Yes', text: 'But tag a release first.' })
  assert.equal(answered.status, 'answered')
  assert.equal(answered.answer?.byName, 'Nico')
  assert.equal(sent.at(-1)!.to, TASK_SESSION)
  assert.match(sent.at(-1)!.text, /Réponse : « Yes »\nPrécision : But tag a release first\.\nRépondu par Nico\./)
  assert.ok(db.select().from(decisions).get()!.deliveredAt)
  await assert.rejects(service.answer('owner', row.id, { option: 'No', text: '' }), /no longer pending/)

  // Deadlines deliver default choices to sessions.
  await ask(TASK_SESSION, 'request_decision', { question: 'Release now?', options: ['Yes', 'No'], default: 'No' })
  const second = db.select().from(decisions).where(eq(decisions.status, 'pending')).get()!
  db.update(decisions).set({ expiresAt: Date.now() - 1 }).where(eq(decisions.id, second.id)).run()
  await service.tick()
  assert.equal(db.select().from(decisions).where(eq(decisions.id, second.id)).get()!.status, 'expired')
  assert.match(sent.at(-1)!.text, /expiré sans réponse[\s\S]*« No »/)
  assert.equal(service.get('owner', second.id).answer?.option, 'No')

  // Agent withdrawal and withdrawal when sessions are archived.
  await ask(TASK_SESSION, 'request_decision', { question: 'Bump the version?' })
  const withdrawn = await ask(TASK_SESSION, 'withdraw_decision', { reason: 'A newer comment answered it.' })
  assert.equal(withdrawn.isError, false)
  assert.equal(service.list('owner', 'all')[0]!.withdrawnReason, 'A newer comment answered it.')
  await ask(TASK_SESSION, 'request_decision', { question: 'Close the issue?' })
  db.update(conversations).set({ archivedAt: Date.now() }).where(eq(conversations.id, TASK_SESSION)).run()
  const before = sent.length
  await service.tick()
  assert.equal(service.list('owner', 'pending').length, 0)
  assert.equal(sent.length, before, 'Nothing is delivered to an archived session')

  // Board maintenance decisions appear in card threads.
  await ask(BOARD_SESSION, 'request_decision', { question: 'Label it as a duplicate?', options: ['Yes', 'No'] })
  const board = service.list('owner', 'pending')[0]!
  assert.equal(board.source.kind, 'board')
  assert.equal(board.source.label, 'Issue #42')
  assert.equal(board.source.cardNumber, 7)
  await service.answer('owner', board.id, { option: 'No', text: '' })
  assert.match(db.select().from(cardNotes).where(eq(cardNotes.cardId, 'card')).all().at(-1)!.body, /Décision : Label it as a duplicate\?\n→ « No »/)
})

test('decision routes: only the owner sees and answers', async (t) => {
  const { db, service, ask } = await harness(t)
  db.update(scheduledTasks).set({ decisionsEnabled: true }).run()
  await ask(TASK_SESSION, 'request_decision', { question: 'Ship it?', options: ['Yes', 'No'] })
  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, String(request.headers['x-user'] ?? 'owner'))).get()
  })
  registerErrorHandler(app)
  registerDecisionRoutes(app, service)
  t.after(() => app.close())

  const list = (await app.inject('/api/decisions')).json() as { decisions: Array<{ id: string; question: string }> }
  assert.equal(list.decisions.length, 1)
  const id = list.decisions[0]!.id
  assert.equal(((await app.inject({ url: '/api/decisions', headers: { 'x-user': 'other' } })).json() as { decisions: unknown[] }).decisions.length, 0)
  assert.equal((await app.inject({ method: 'POST', url: `/api/decisions/${id}/answer`, headers: { 'x-user': 'other' }, payload: { option: 'Yes' } })).statusCode, 404)
  assert.equal((await app.inject({ method: 'POST', url: `/api/decisions/${id}/answer`, payload: {} })).statusCode, 400, 'An empty answer is refused')
  const answered = await app.inject({ method: 'POST', url: `/api/decisions/${id}/answer`, payload: { option: null, text: 'Not before Friday.' } })
  assert.equal(answered.statusCode, 200, answered.body)
  assert.equal(answered.json().answer.text, 'Not before Friday.')
})

test('notifications: toast where the app is visible, push elsewhere, nothing when watched or turned off', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-notify-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()

  const pushed: Array<{ payload: PushPayload; except: Set<string> | undefined }> = []
  const push = { notify: async (_userId: string, payload: PushPayload, options: { except?: Set<string> } = {}) => { pushed.push({ payload, except: options.except }); return [] } } as unknown as PushService
  const toasts: InAppNotification[] = []
  let watching = false
  const notifications = new Notifications(db, push)
  notifications.setPresence({
    visibleEndpoints: () => new Set(['https://web.push.apple.com/mac']),
    watchesVisibly: () => watching,
    toast: (_userId, notification) => { toasts.push(notification) },
    decisionsChanged: () => {},
  })
  const request = {
    kind: 'cliRequest' as const,
    conversationId: 'c1',
    push: { title: 'Approval', body: 'Session', url: '/p/x/c/c1', tag: 'c1', kind: 'permission' as const },
    toast: { kind: 'cliRequest' as const, request: 'permission' as const, conversationId: 'c1', projectId: 'x', conversationTitle: 'Session', detail: 'Bash : npm test' },
  }

  await notifications.dispatch('owner', request)
  assert.equal(toasts.length, 1)
  assert.deepEqual([...pushed[0]!.except!], ['https://web.push.apple.com/mac'], 'The visible device gets the toast, not the push')

  watching = true
  await notifications.dispatch('owner', request)
  assert.equal(toasts.length, 1, 'Already in front of the conversation: nothing')
  assert.equal(pushed.length, 1)

  watching = false
  db.insert(await import('@sillage/db').then((module) => module.userSettings)).values({ userId: 'owner', data: JSON.stringify({ notifications: { decision: true, cliRequest: false, turnCompleted: true } }) }).run()
  await notifications.dispatch('owner', request)
  assert.equal(pushed.length, 1, 'Turned off in the preferences')
})


test('les anciennes propositions de nettoyage se retirent sans action, les décisions humaines restent', async (t) => {
  const { db, service, sent, dispatched, changed } = await harness(t)
  db.update(scheduledTasks).set({ decisionsEnabled: true }).run()
  const requester = db.select().from(conversations).where(eq(conversations.id, TASK_SESSION)).get()!
  await service.request(requester, { question: 'Publier la mise à jour ?', options: ['Oui', 'Non'] })
  const human = service.list('owner', 'pending')[0]!
  const now = Date.now()
  for (const [id, status] of [['old-cleanup', 'pending'], ['old-kept', 'answered'], ['old-expired', 'pending']] as const) {
    db.insert(decisions).values({
      id, projectId: 'project', userId: 'owner', conversationId: HUMAN_SESSION,
      sourceKind: 'worktree', sourceLabel: 'feat/done', question: 'Nettoyer ?', context: '',
      options: '["clean","keep"]', worktreePath: '/a/worktree', status,
      expiresAt: id === 'old-expired' ? now - 1 : now + 86_400_000, createdAt: now,
      ...(status === 'answered' ? { answerOption: 'keep', resolvedAt: now, deliveredAt: now } : {}),
    }).run()
  }
  assert.equal(service.pendingCount('owner'), 1, 'Le badge compte seulement les demandes des agents')
  const notificationsBefore = dispatched.length
  const changesBefore = changed.length
  await service.tick()
  assert.deepEqual(service.list('owner', 'pending').map((row) => row.id), [human.id])
  for (const id of ['old-cleanup', 'old-expired']) {
    const closed = service.get('owner', id)
    assert.equal(closed.status, 'withdrawn')
    assert.match(closed.withdrawnReason ?? '', /conversation ou la vue Chantiers/)
    await assert.rejects(service.answer('owner', id, { option: 'clean', text: '' }), /no longer pending/)
  }
  assert.equal(service.get('owner', 'old-kept').answer?.option, 'keep', 'Les réponses passées restent lisibles')
  assert.equal(dispatched.length, notificationsBefore, 'Aucune notification de nettoyage')
  assert.equal(sent.length, 0, 'Aucune session ne se relance pour un nettoyage')
  assert.equal(changed.length, changesBefore + 2, 'Les onglets retirent les propositions périmées')
  await service.tick()
  assert.equal(changed.length, changesBefore + 2, 'Le retrait ne se répète pas')

  // Old tabs may answer before the first pass: no cleanup starts.
  db.update(decisions).set({ status: 'pending' }).where(eq(decisions.id, 'old-cleanup')).run()
  await assert.rejects(service.answer('owner', 'old-cleanup', { option: 'clean', text: '' }), /no longer pending/)
  assert.equal(service.get('owner', 'old-cleanup').status, 'withdrawn')
  await service.answer('owner', human.id, { option: 'Oui', text: '' })
  assert.equal(sent.length, 1, 'Une vraie décision relance toujours son agent')
})
