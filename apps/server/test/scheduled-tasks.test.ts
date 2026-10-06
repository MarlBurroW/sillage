import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { asc, eq } from 'drizzle-orm'
import {
  conversations,
  openDatabase,
  projects,
  runMigrations,
  scheduledRuns,
  scheduledTasks,
  users,
} from '@sillage/db'
import {
  DEFAULT_CLAUDE_CONFIG,
  nextScheduleRun,
  type AgentConfig,
  type ScheduleCadence,
  type ScheduleOverlapPolicy,
} from '@sillage/protocol'
import type { AgentRegistry } from '../src/agents/registry.js'
import type { Config } from '../src/config.js'
import { EventLog } from '../src/events/event-log.js'
import { TaskScheduler, buildRunPrompt } from '../src/scheduler/task-scheduler.js'
import { createScheduledTask, deleteScheduledTask } from '../src/scheduler/tasks.js'
import { AgentRequests } from '../src/sessions/agent-requests.js'
import type { SessionManager } from '../src/sessions/session-manager.js'

const MINUTE = 60_000

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-scheduled-tasks-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())

  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()

  const sent: { to: string; text: string }[] = []
  const terminated: string[] = []
  let failSend = false
  const sessions = {
    async sendMessage(to: string, _id: string, text: string) {
      if (failSend) throw new Error('CLI introuvable')
      sent.push({ to, text })
      // Le vrai gestionnaire passe le fil en `running` dès que le CLI prend le tour.
      db.update(conversations).set({ status: 'running' }).where(eq(conversations.id, to)).run()
    },
    async terminate(id: string) {
      terminated.push(id)
      db.update(conversations).set({ status: 'interrupted' }).where(eq(conversations.id, id)).run()
    },
  } as unknown as SessionManager
  const registry = {
    adapter: () => ({
      models: async () => ({ models: [] }),
      resolveDefaults: async (config: AgentConfig) => (config.model ? config : { ...config, model: 'default' }),
    }),
  } as unknown as AgentRegistry
  const config = {
    paths: { worktrees: join(dir, 'worktrees') },
    server: { publicUrl: 'https://sillage.example/' },
  } as unknown as Config
  const log = new EventLog(db)
  const scheduler = new TaskScheduler({ db, config }, sessions, registry, log)

  const task = (cadence: ScheduleCadence, overlapPolicy: ScheduleOverlapPolicy = 'skip', maxDurationMinutes = 30) =>
    createScheduledTask(
      db,
      { projectId: 'project', userId: 'owner' },
      { name: 'Veille', agent: 'claude', config: DEFAULT_CLAUDE_CONFIG, prompt: 'Sonde les CLI.', cadence, overlapPolicy, maxDurationMinutes, enabled: true },
    )

  /** Fait finir le tour d'un fil comme le ferait le CLI : une réponse, puis le repos. */
  const finish = (conversationId: string, reply: string) => {
    log.append(conversationId, {
      type: 'message.completed',
      messageId: `m-${reply}`,
      role: 'assistant',
      blocks: [{ type: 'text', text: reply }],
      parentToolCallId: null,
    })
    log.append(conversationId, {
      type: 'turn.completed',
      stopReason: 'end_turn',
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    })
    db.update(conversations).set({ status: 'idle' }).where(eq(conversations.id, conversationId)).run()
  }

  const runs = () => db.select().from(scheduledRuns).orderBy(asc(scheduledRuns.startedAt), asc(scheduledRuns.scheduledFor)).all()
  const reload = (id: string) => db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).get()!

  return {
    db, dbPath, sessions, registry, config, scheduler, task, finish, runs, reload, sent, terminated,
    failNextSends: () => { failSend = true },
  }
}

test('nextScheduleRun counts an interval from the last run and never catches up', () => {
  const every10: ScheduleCadence = { kind: 'interval', minutes: 10 }
  assert.equal(nextScheduleRun(every10, 1000), 1000 + 10 * MINUTE)
  assert.equal(nextScheduleRun(every10, 5 * MINUTE, MINUTE), 11 * MINUTE)
  // Le daemon est resté arrêté trois intervalles : un seul tir à venir, pas trois.
  assert.equal(nextScheduleRun(every10, 40 * MINUTE, MINUTE), 50 * MINUTE)

  assert.equal(nextScheduleRun({ kind: 'once', at: 500 }, 100), 500)
  assert.equal(nextScheduleRun({ kind: 'once', at: 500 }, 500), null)

  const monday = nextScheduleRun({ kind: 'cron', expression: '0 9 * * 1' }, Date.now())!
  assert.equal(new Date(monday).getDay(), 1)
  assert.equal(new Date(monday).getHours(), 9)
})

test('buildRunPrompt tells the agent it runs alone and hands over the previous run', () => {
  const task = { name: 'Veille', prompt: 'Compare à {{previous_run_summary}} ({{previous_run_date}}).', projectId: 'p', maxDurationMinutes: 20 }
  const first = buildRunPrompt({ task, trigger: 'schedule', firedAt: Date.now(), previous: null, publicUrl: '' })
  assert.match(first, /personne n'est au clavier/)
  assert.match(first, /premier tir/)
  assert.match(first, /20 min/)

  const next = buildRunPrompt({
    task,
    trigger: 'manual',
    firedAt: Date.now(),
    previous: { startedAt: Date.now() - MINUTE, status: 'succeeded', conversationId: 'c1', summary: 'Rien de neuf.', error: null },
    publicUrl: 'https://sillage.example/',
  })
  assert.match(next, /lancé à la main/)
  assert.match(next, /https:\/\/sillage\.example\/p\/p\/c\/c1/)
  assert.match(next, /> Rien de neuf\./)
  assert.match(next, /Compare à Rien de neuf\. \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)\./)
})

test('a due task opens a tagged session, then settles with the last reply as summary', async (t) => {
  const { db, scheduler, task, finish, runs, reload, sent } = await harness(t)
  const created = task({ kind: 'interval', minutes: 10 })
  const due = created.nextRunAt!

  await scheduler.tick(due - 1)
  assert.equal(runs().length, 0)

  await scheduler.tick(due)
  const [run] = runs()
  assert.equal(run?.status, 'running')
  assert.equal(run?.trigger, 'schedule')
  const thread = db.select().from(conversations).where(eq(conversations.id, run!.conversationId!)).get()!
  assert.equal(thread.scheduleId, created.id)
  assert.match(thread.title, /^Veille · \d{4}-/)
  assert.match(sent[0]!.text, /Sonde les CLI\.$/)
  assert.ok(reload(created.id).nextRunAt! > due)
  assert.ok(reload(created.id).lastRunAt)

  // Le fil tourne : rien ne bouge.
  await scheduler.tick(due + MINUTE)
  assert.equal(runs()[0]?.status, 'running')

  finish(thread.id, 'Aucune nouvelle version.')
  await scheduler.tick(due + 2 * MINUTE)
  assert.equal(runs()[0]?.status, 'succeeded')
  assert.equal(runs()[0]?.summary, 'Aucune nouvelle version.')
})

test('a thread that has not started its turn yet is not mistaken for a finished one', async (t) => {
  const { db, scheduler, task, runs } = await harness(t)
  const created = task({ kind: 'interval', minutes: 10 })
  await scheduler.tick(created.nextRunAt!)
  db.update(conversations).set({ status: 'idle' }).run()

  await scheduler.tick(created.nextRunAt! + MINUTE)
  assert.equal(runs()[0]?.status, 'running')
})

test('overlap: skip records a skipped run, wait fires once the previous one is done', async (t) => {
  const { scheduler, task, finish, runs, reload } = await harness(t)
  const skipping = task({ kind: 'interval', minutes: 10 }, 'skip')
  await scheduler.tick(skipping.nextRunAt!)
  const second = reload(skipping.id).nextRunAt!
  await scheduler.tick(second)
  assert.deepEqual(runs().map((run) => run.status), ['running', 'skipped'])
  assert.ok(reload(skipping.id).nextRunAt! > second)

  finish(runs()[0]!.conversationId!, 'ok')
  await scheduler.tick(second + MINUTE)

  const waiting = task({ kind: 'interval', minutes: 10 }, 'wait')
  const mine = () => runs().filter((run) => run.taskId === waiting.id)
  await scheduler.tick(waiting.nextRunAt!)
  const dueAgain = reload(waiting.id).nextRunAt!
  await scheduler.tick(dueAgain)
  assert.equal(mine().length, 1)
  assert.equal(reload(waiting.id).nextRunAt, dueAgain)

  finish(mine()[0]!.conversationId!, 'ok')
  await scheduler.tick(dueAgain + MINUTE)
  assert.deepEqual(mine().map((run) => run.status).sort(), ['running', 'succeeded'])
})

test('a run that outlives its maximum duration is terminated', async (t) => {
  const { scheduler, task, runs, terminated } = await harness(t)
  const created = task({ kind: 'interval', minutes: 60 }, 'skip', 5)
  await scheduler.tick(created.nextRunAt!)
  const startedAt = runs()[0]!.startedAt

  await scheduler.tick(startedAt + 4 * MINUTE)
  assert.equal(runs()[0]?.status, 'running')

  await scheduler.tick(startedAt + 5 * MINUTE)
  assert.equal(runs()[0]?.status, 'timed_out')
  assert.deepEqual(terminated, [runs()[0]!.conversationId])
})

test('a one-off task fires once and pauses itself; a failed launch is recorded, not retried', async (t) => {
  const { db, scheduler, task, runs, reload, failNextSends } = await harness(t)
  const once = task({ kind: 'once', at: Date.now() + MINUTE })
  await scheduler.tick(once.nextRunAt!)
  assert.equal(runs().length, 1)
  assert.equal(reload(once.id).enabled, false)
  assert.equal(reload(once.id).nextRunAt, null)

  failNextSends()
  const broken = task({ kind: 'interval', minutes: 10 })
  await scheduler.tick(broken.nextRunAt!)
  const failed = runs().find((run) => run.taskId === broken.id)!
  assert.equal(failed.status, 'failed')
  assert.match(failed.error!, /CLI introuvable/)
  // Le fil créé pour rien a été retiré, et la tâche attend son prochain créneau.
  assert.equal(db.select().from(conversations).where(eq(conversations.scheduleId, broken.id)).all().length, 0)
  assert.ok(reload(broken.id).nextRunAt! > broken.nextRunAt!)
})

test('run now refuses to double a run in flight and leaves the schedule alone', async (t) => {
  const { scheduler, task, runs, reload } = await harness(t)
  const created = task({ kind: 'interval', minutes: 10 })

  const run = await scheduler.runNow(created.id)
  assert.equal(run.trigger, 'manual')
  assert.equal(reload(created.id).nextRunAt, created.nextRunAt)
  await assert.rejects(scheduler.runNow(created.id), /still in progress/)
  assert.equal(runs().length, 1)
})

test('deleting a task archives its threads and hands them back to the ordinary list', async (t) => {
  const { db, scheduler, task } = await harness(t)
  const created = task({ kind: 'interval', minutes: 10 })
  await scheduler.runNow(created.id)

  const running = deleteScheduledTask(db, created.id)
  const [thread] = db.select().from(conversations).all()
  assert.deepEqual(running, [thread!.id])
  assert.equal(thread?.scheduleId, null)
  assert.ok(thread?.archivedAt)
  assert.equal(db.select().from(scheduledRuns).all().length, 0)
})

test('schedule_task creates a task from a session, within the agent guard rails', async (t) => {
  const { db, dbPath, sessions, registry, config } = await harness(t)
  db.insert(conversations).values({
    id: 'parent', projectId: 'project', userId: 'owner', title: 'Session', agent: 'claude', config: '{}', status: 'running',
    createdAt: 1, updatedAt: Date.now(),
  }).run()
  db.insert(conversations).values({
    id: 'scheduled', projectId: 'project', userId: 'owner', title: 'Tir', agent: 'claude', config: '{}', status: 'running',
    scheduleId: 'some-task', createdAt: 1, updatedAt: Date.now(),
  }).run()
  const requests = new AgentRequests({ db, config }, sessions, registry)

  const mcp = async (from: string, args: object) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
      env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: 'project', SILLAGE_MCP_CONVERSATION: from },
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'schedule_task', arguments: args } }) + '\n')
    const deadline = Date.now() + 10000
    while (!stdout.includes('\n') && Date.now() < deadline) {
      await requests.sweep()
      await new Promise((done) => setTimeout(done, 50))
    }
    child.kill()
    return JSON.parse(stdout).result as { content: { text: string }[]; isError?: boolean }
  }

  const created = await mcp('parent', { name: 'Veille des CLI', prompt: 'Sonde les binaires.', cron: '0 9 * * 1' })
  assert.equal(created.isError, undefined, created.content[0]?.text)
  assert.match(created.content[0]!.text, /Tâche planifiée « Veille des CLI » créée/)
  // Les défauts sont en permissions manuelles : la réponse doit le signaler.
  assert.match(created.content[0]!.text, /personne ne donnera/)
  const row = db.select().from(scheduledTasks).get()!
  assert.equal(row.createdByConversationId, 'parent')
  assert.deepEqual(JSON.parse(row.cadence), { kind: 'cron', expression: '0 9 * * 1' })
  assert.equal(new Date(row.nextRunAt!).getDay(), 1)

  const tooTight = await mcp('parent', { name: 'x', prompt: 'x', every_minutes: 5 })
  assert.equal(tooTight.isError, true)
  assert.match(tooTight.content[0]!.text, /15 minutes au moins/)

  const tightCron = await mcp('parent', { name: 'x', prompt: 'x', cron: '* * * * *' })
  assert.match(tightCron.content[0]!.text, /trop serré/)

  const ambiguous = await mcp('parent', { name: 'x', prompt: 'x', every_minutes: 60, cron: '0 9 * * 1' })
  assert.match(ambiguous.content[0]!.text, /exactement une cadence/)

  const selfReplicating = await mcp('scheduled', { name: 'x', prompt: 'x', every_minutes: 60 })
  assert.equal(selfReplicating.isError, true)
  assert.match(selfReplicating.content[0]!.text, /elle-même un tir planifié/)

  assert.equal(db.select().from(scheduledTasks).all().length, 1)
})
