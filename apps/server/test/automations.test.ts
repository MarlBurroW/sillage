import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { asc, eq } from 'drizzle-orm'
import {
  agentRequests,
  automationDeliveries,
  automationWebhooks,
  conversations,
  openDatabase,
  projects,
  runMigrations,
  scheduledTasks,
  users,
} from '@sillage/db'
import {
  AUTOMATION_TEMPLATES,
  DEFAULT_CLAUDE_CONFIG,
  evaluateConditions,
  findSessionMarkers,
  readPath,
  renderTemplate,
  sessionMarker,
  type AgentConfig,
  type AutomationEvent,
  type WebhookSettings,
} from '@sillage/protocol'
import Fastify from 'fastify'
import type { AgentRegistry } from '../src/agents/registry.js'
import { registerAutomationRoutes } from '../src/http/routes/automations.js'
import { AutomationReceiver } from '../src/automations/receiver.js'
import { runAutomationScript } from '../src/automations/script.js'
import { createWebhook, revealSecret, verifyCaller } from '../src/automations/webhooks.js'
import type { Config } from '../src/config.js'
import { EventLog } from '../src/events/event-log.js'
import type { PushService } from '../src/push/push-service.js'
import { TaskScheduler } from '../src/scheduler/task-scheduler.js'
import { createScheduledTask } from '../src/scheduler/tasks.js'
import type { SessionManager } from '../src/sessions/session-manager.js'

const event = (payload: unknown, headers: Record<string, string> = {}): AutomationEvent => ({
  headers,
  query: {},
  payload,
  body: JSON.stringify(payload),
})

test('paths read nested values, indexes and wildcards', () => {
  const payload = { issue: { number: 12, labels: [{ name: 'bug' }, { name: 'sillage' }] }, commits: [{ id: 'a1' }] }
  assert.equal(readPath(payload, 'issue.number'), 12)
  assert.equal(readPath(payload, 'commits.0.id'), 'a1')
  assert.deepEqual(readPath(payload, 'issue.labels.*.name'), ['bug', 'sillage'])
  assert.equal(readPath(payload, 'issue.missing.deeper'), undefined)
  assert.equal(readPath(event({}, { 'x-github-event': 'issues' }), 'headers.x-github-event'), 'issues')
})

test('conditions: a negation on a list fails as soon as one item matches', () => {
  const sample = event({ action: 'labeled', labels: [{ name: 'bug' }, { name: 'wip' }], draft: false }, { 'x-github-event': 'issues' })
  const run = (rules: Parameters<typeof evaluateConditions>[0]['rules'], mode: 'all' | 'any' = 'all') =>
    evaluateConditions({ mode, rules }, sample)
  assert.equal(run([{ path: 'headers.x-github-event', op: 'equals', value: 'issues' }]).ok, true)
  assert.equal(run([{ path: 'payload.labels.*.name', op: 'contains', value: 'wip' }]).ok, true)
  assert.equal(run([{ path: 'payload.labels.*.name', op: 'not_equals', value: 'wip' }]).ok, false)
  assert.equal(run([{ path: 'payload.action', op: 'in', value: 'opened, labeled' }]).ok, true)
  assert.equal(run([{ path: 'payload.draft', op: 'equals', value: 'false' }]).ok, true)
  assert.equal(run([{ path: 'payload.nothing', op: 'missing', value: '' }]).ok, true)
  assert.equal(run([{ path: 'payload.action', op: 'matches', value: '^LAB' }]).ok, true)
  const broken = run([{ path: 'payload.action', op: 'matches', value: '(' }])
  assert.equal(broken.ok, false)
  assert.ok(broken.results[0]?.error)
  assert.equal(run([
    { path: 'payload.action', op: 'equals', value: 'closed' },
    { path: 'payload.action', op: 'equals', value: 'labeled' },
  ], 'any').ok, true)
})

test('templates render values, keep unknown markers in preview, and markers are found', () => {
  const scope = { payload: { issue: { title: 'Crash', number: 3 } } }
  assert.equal(renderTemplate('#{{payload.issue.number}} {{ payload.issue.title }}', scope), '#3 Crash')
  assert.equal(renderTemplate('{{payload.nope}}!', scope), '!')
  assert.equal(renderTemplate('{{payload.nope}}!', scope, { keepMissing: true }), '{{payload.nope}}!')
  const id = randomUUID()
  assert.deepEqual(findSessionMarkers(`Corrigé.\n\n${sessionMarker(id)}`), [id])
  assert.deepEqual(findSessionMarkers(`fix: x\n\nSillage-Session: ${id}`), [id])
})

test('GitHub signatures verify against the documented test vector', () => {
  // Example from GitHub's Validating webhook deliveries documentation.
  const secret = "It's a Secret to Everybody"
  const raw = Buffer.from('Hello, World!')
  const header = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'
  const github = AUTOMATION_TEMPLATES[0]!.settings.verification
  assert.equal(verifyCaller(github, secret, { 'x-hub-signature-256': header }, raw), true)
  assert.equal(verifyCaller(github, secret, { 'x-hub-signature-256': header }, Buffer.from('Hello, World?')), false)
  assert.equal(verifyCaller(github, secret, {}, raw), false)
  assert.equal(verifyCaller({ kind: 'token', header: 'x-gitlab-token' }, 's3', { 'x-gitlab-token': 's3' }, raw), true)
})

test('scripts decide in a sandbox with no network, and runaway scripts are stopped', async () => {
  const sample = event({ comment: { body: '/sillage fix the build' }, issue: { number: 9 } })
  const launch = await runAutomationScript(
    `export default function (event) {
       const cmd = event.payload.comment.body.match(/^\\/sillage\\s+(.+)/)
       console.log('cmd', cmd && cmd[1])
       return cmd ? { subject: 'issue-' + event.payload.issue.number, vars: { instruction: cmd[1] } } : null
     }`,
    sample,
  )
  assert.equal(launch.error, null)
  assert.deepEqual(launch.decision, { kind: 'launch', subject: 'issue-9', vars: { instruction: 'fix the build' } })
  assert.deepEqual(launch.logs, ['cmd fix the build'])

  const skip = await runAutomationScript(`export default () => ({ skip: 'pas une commande' })`, sample)
  assert.deepEqual(skip.decision, { kind: 'skip', reason: 'pas une commande' })

  const loop = await runAutomationScript('export default () => { while (true) {} }', sample)
  assert.equal(loop.error?.code, 'script_timeout')

  const sandboxed = await runAutomationScript('export default () => ({ vars: { kinds: [typeof fetch, typeof require, typeof process].join() } })', sample)
  assert.deepEqual(sandboxed.decision, { kind: 'launch', subject: null, vars: { kinds: 'undefined,undefined,undefined' } })

  const wrong = await runAutomationScript('export default () => 42', sample)
  assert.equal(wrong.error?.code, 'script_contract')
})

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-automations-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()

  const sent: { to: string; text: string }[] = []
  const sessions = {
    async sendMessage(to: string, _id: string, text: string) {
      sent.push({ to, text })
      db.update(conversations).set({ status: 'running' }).where(eq(conversations.id, to)).run()
    },
  } as unknown as SessionManager
  const registry = {
    adapter: () => ({ resolveDefaults: async (config: AgentConfig) => (config.model ? config : { ...config, model: 'default' }) }),
  } as unknown as AgentRegistry
  const config = { paths: { worktrees: join(dir, 'worktrees') }, server: { publicUrl: 'https://sillage.example' } } as unknown as Config
  const scheduler = new TaskScheduler({ db, config }, sessions, registry, new EventLog(db))
  const pushes: string[] = []
  const push = { notify: async (_user: string, payload: { title: string }) => { pushes.push(payload.title) } } as unknown as PushService
  const key = randomBytes(32)
  const receiver = new AutomationReceiver({ db, config }, key, scheduler, push)
  // Tests drive sweeps themselves: asynchronous wakeups would race with
  // `tick()` calls and make verdicts nondeterministic.
  scheduler.kick = () => {}

  const automation = (settings: Partial<WebhookSettings> = {}, overlapPolicy: 'skip' | 'wait' = 'wait') => {
    const task = createScheduledTask(db, { projectId: 'project', userId: 'owner' }, {
      name: 'Issues', agent: 'claude', config: DEFAULT_CLAUDE_CONFIG,
      prompt: 'Traite #{{payload.issue.number}} : {{payload.issue.title}} ({{vars.note}})',
      cadence: { kind: 'webhook' }, overlapPolicy, maxDurationMinutes: 30, enabled: true,
    })
    const hook = createWebhook(db, key, task.id, settings, null)
    return { task, hook, secret: revealSecret(key, hook) }
  }

  const call = (token: string, payload: unknown, headers: Record<string, string> = {}) =>
    receiver.receive(token, { 'content-type': 'application/json', ...headers }, {}, Buffer.from(JSON.stringify(payload)))

  const deliveries = (taskId: string) =>
    db.select().from(automationDeliveries).where(eq(automationDeliveries.taskId, taskId)).orderBy(asc(automationDeliveries.receivedAt)).all()

  return { db, config, scheduler, receiver, automation, call, deliveries, sent, pushes }
}

test('a signed call that passes the conditions is queued, then fired with its payload in the prompt', async (t) => {
  const { db, scheduler, automation, call, deliveries, sent } = await harness(t)
  const { task, hook, secret } = automation({
    verification: { kind: 'hmac', header: 'x-hub-signature-256', algorithm: 'sha256', prefix: 'sha256=' },
    deliveryHeader: 'x-github-delivery',
    conditions: { mode: 'all', rules: [{ path: 'payload.action', op: 'equals', value: 'labeled' }] },
    subjectPath: 'payload.issue.number',
    script: `export default (e) => ({ vars: { note: 'urgent' } })`,
  })
  const payload = { action: 'labeled', issue: { number: 7, title: 'Crash au démarrage' } }
  const sign = (body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

  const unsigned = await call(hook.token, payload)
  assert.equal(unsigned.status, 401)

  const accepted = await call(hook.token, payload, { 'x-hub-signature-256': sign(JSON.stringify(payload)), 'x-github-delivery': 'd-1' })
  assert.equal(accepted.status, 202)
  assert.equal(accepted.body.verdict, 'queued')

  const again = await call(hook.token, payload, { 'x-hub-signature-256': sign(JSON.stringify(payload)), 'x-github-delivery': 'd-1' })
  assert.equal(again.body.verdict, 'duplicate')

  await scheduler.tick()
  const launched = deliveries(task.id).find((row) => row.id === accepted.body.delivery)!
  assert.equal(launched.verdict, 'launched')
  assert.equal(launched.subject, '7')
  assert.ok(launched.conversationId)
  const prompt = sent.find((entry) => entry.to === launched.conversationId)!.text
  assert.match(prompt, /Traite #7 : Crash au démarrage \(urgent\)/)
  assert.match(prompt, new RegExp(sessionMarker(launched.conversationId!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const thread = db.select().from(conversations).where(eq(conversations.id, launched.conversationId!)).get()!
  assert.equal(thread.scheduleId, task.id)
  // Signing secrets must never reach journals.
  assert.equal(JSON.parse(launched.headers)['x-hub-signature-256'], undefined)
})

test('filtered calls say which condition failed; script skips and errors are logged', async (t) => {
  const { automation, call } = await harness(t)
  const filtered = automation({ conditions: { mode: 'all', rules: [{ path: 'payload.action', op: 'equals', value: 'labeled' }] } })
  const result = await call(filtered.hook.token, { action: 'closed' })
  assert.equal(result.body.verdict, 'filtered')
  assert.deepEqual(result.body.reason, { code: 'filter_rule', params: { index: 1, path: 'payload.action', actual: 'closed' } })

  const skipping = automation({ script: `export default () => ({ skip: 'hors sujet' })` })
  const skipped = await call(skipping.hook.token, {})
  assert.equal(skipped.body.verdict, 'script_skipped')
  assert.deepEqual(skipped.body.reason, { code: 'script_skip', params: { reason: 'hors sujet' } })
  const crashing = automation({ script: 'export default () => { throw new Error("boum") }' })
  const crashed = await call(crashing.hook.token, {})
  assert.equal(crashed.body.verdict, 'script_error')
  assert.equal(crashed.body.reason?.code, 'script_exception')
  assert.match(String(crashed.body.reason?.params?.message), /boum/)
})

test('queued calls on the same subject coalesce, and skip mode refuses while busy', async (t) => {
  const { automation, call, deliveries } = await harness(t)
  const waiting = automation({ subjectPath: 'payload.issue.number' })
  const first = await call(waiting.hook.token, { issue: { number: 1 }, n: 1 })
  const second = await call(waiting.hook.token, { issue: { number: 1 }, n: 2 })
  const other = await call(waiting.hook.token, { issue: { number: 2 } })
  const rows = deliveries(waiting.task.id)
  assert.equal(rows.find((row) => row.id === first.body.delivery)?.verdict, 'coalesced')
  assert.equal(rows.find((row) => row.id === second.body.delivery)?.verdict, 'queued')
  assert.equal(rows.find((row) => row.id === other.body.delivery)?.verdict, 'queued')

  const skipping = automation({}, 'skip')
  await call(skipping.hook.token, { n: 1 })
  assert.equal((await call(skipping.hook.token, { n: 2 })).body.verdict, 'busy')
})

test('the circuit breaker pauses an automation that fires too often, and tells its owner', async (t) => {
  const { db, automation, call, pushes } = await harness(t)
  const { task, hook } = automation({ maxRunsPerHour: 2 })
  await call(hook.token, { n: 1 })
  await call(hook.token, { n: 2 })
  const third = await call(hook.token, { n: 3 })
  assert.equal(third.body.verdict, 'circuit_open')
  assert.equal(db.select().from(scheduledTasks).where(eq(scheduledTasks.id, task.id)).get()!.enabled, false)
  assert.ok(db.select().from(automationWebhooks).where(eq(automationWebhooks.taskId, task.id)).get()!.trippedAt)
  assert.equal(pushes.length, 1)
  assert.equal((await call(hook.token, { n: 4 })).body.verdict, 'disabled')
})

test('a call marked by a session deep in a launch chain is refused, like start_session', async (t) => {
  const { db, automation, call } = await harness(t)
  const thread = (id: string) => db.insert(conversations).values({
    id, projectId: 'project', userId: 'owner', title: id, agent: 'claude', config: '{}', status: 'idle', createdAt: 1, updatedAt: 1,
  }).run()
  const [root, child, grandchild] = [randomUUID(), randomUUID(), randomUUID()]
  for (const id of [root, child, grandchild]) thread(id)
  const lineage = (from: string, to: string) => db.insert(agentRequests).values({
    id: randomUUID(), projectId: 'project', conversationId: from, kind: 'webhook_launch', payload: '{}',
    createdAt: Date.now(), settledAt: Date.now(), result: null, isError: false, launchedConversationId: to,
  }).run()
  lineage(root, child)
  lineage(child, grandchild)

  const { hook } = automation({ markerPaths: 'payload.comment.body' })
  const fromRoot = await call(hook.token, { comment: { body: `ok\n${sessionMarker(root)}` } })
  assert.equal(fromRoot.body.verdict, 'queued')
  const fromDeep = await call(hook.token, { comment: { body: `ok\n${sessionMarker(grandchild)}` } })
  assert.equal(fromDeep.body.verdict, 'chain_refused')
  // Markers outside designated fields do not count: human-applied labels on
  // agent-written issues remain human actions.
  const elsewhere = await call(hook.token, { issue: { body: sessionMarker(grandchild) }, comment: { body: 'humain' } })
  assert.equal(elsewhere.body.verdict, 'queued')
})

test('a fired session marked by another one is recorded as launched by it', async (t) => {
  const { db, scheduler, automation, call, deliveries } = await harness(t)
  const origin = randomUUID()
  db.insert(conversations).values({
    id: origin, projectId: 'project', userId: 'owner', title: 'origine', agent: 'claude', config: '{}', status: 'idle', createdAt: 1, updatedAt: 1,
  }).run()
  const { task, hook } = automation()
  await call(hook.token, { issue: { number: 4, title: 'x' }, note: sessionMarker(origin) })
  await scheduler.tick()
  const launched = deliveries(task.id)[0]!
  assert.equal(launched.originConversationId, origin)
  const row = db.select().from(agentRequests).where(eq(agentRequests.launchedConversationId, launched.conversationId!)).get()
  assert.equal(row?.conversationId, origin)
  assert.equal(row?.kind, 'webhook_launch')
})

test('the test bench evaluates a call typed on the page and returns the message the agent would read', async (t) => {
  const { db, config, receiver, automation, deliveries } = await harness(t)
  const app = Fastify()
  app.addHook('onRequest', async (request) => {
    ;(request as unknown as { user: { id: string } }).user = { id: 'owner' }
  })
  registerAutomationRoutes(app, { db, config }, receiver)
  await app.ready()
  t.after(() => app.close())

  const { task } = automation({
    conditions: { mode: 'all', rules: [{ path: 'payload.action', op: 'equals', value: 'labeled' }] },
    subjectPath: 'payload.issue.number',
  })
  const test = (body: object) => app.inject({ method: 'POST', url: `/api/schedules/${task.id}/webhook/test`, payload: body }).then((response) => response.json())

  const passes = await test({
    call: { headers: { 'X-GitHub-Event': 'issues' }, body: JSON.stringify({ action: 'labeled', issue: { number: 7, title: 'Crash' } }) },
    // Unsaved prompt currently being edited.
    prompt: 'Traite #{{payload.issue.number}} {{payload.issue.title}} {{payload.missing}}',
  })
  assert.equal(passes.verdict, 'launch')
  assert.equal(passes.subject, '7')
  assert.equal(passes.prompt, 'Traite #7 Crash {{payload.missing}}')
  assert.match(passes.message, /\[Automatisation Sillage « Issues »/)
  assert.match(passes.message, /<!-- sillage:session=<session> -->/)
  assert.match(passes.message, /Événement : issues · labeled\. Sujet : 7\./)

  const ignored = await test({ call: { headers: {}, body: JSON.stringify({ action: 'closed' }) }, settings: { subjectPath: '' } })
  assert.equal(ignored.verdict, 'filtered')
  assert.deepEqual(ignored.reason, { code: 'filter_rule', params: { index: 1, path: 'payload.action', actual: 'closed' } })

  // Trials write nothing to journals.
  assert.equal(deliveries(task.id).length, 0)
})
