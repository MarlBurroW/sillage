import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { conversations, openDatabase, projects, runMigrations, scheduledTasks, usageLimitResumes, users, userSettings } from '@sillage/db'
import { DEFAULT_USAGE_LIMIT_RESUME_MESSAGE, type SillageEvent } from '@sillage/protocol'
import { EventLog } from '../src/events/event-log.js'
import type { OutgoingNotification } from '../src/notifications/dispatcher.js'
import type { SessionManager } from '../src/sessions/session-manager.js'
import { resumeText, UsageLimitResumeService } from '../src/usage-limits/resume-service.js'

const HUMAN = '22222222-0000-4000-8000-000000000001'
const TASK = '22222222-0000-4000-8000-000000000002'

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-usage-limit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())

  const now = Date.now()
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'Nico', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'Nimbus', workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  db.insert(scheduledTasks).values({
    id: 'task', projectId: 'project', userId: 'owner', name: 'Veille', agent: 'claude', config: '{}', prompt: 'p',
    cadence: JSON.stringify({ kind: 'interval', minutes: 60 }), executionMode: 'fresh', overlapPolicy: 'skip', maxDurationMinutes: 30,
    enabled: true, createdAt: now, updatedAt: now,
  }).run()
  const conversation = (id: string, extra: Partial<typeof conversations.$inferInsert> = {}) =>
    db.insert(conversations).values({ id, projectId: 'project', userId: 'owner', title: `Session ${id.slice(-1)}`, agent: 'claude', config: '{}', status: 'idle', createdAt: now, updatedAt: now, ...extra }).run()
  conversation(HUMAN)
  conversation(TASK, { scheduleId: 'task' })

  const log = new EventLog(db)
  const sent: Array<{ to: string; text: string }> = []
  const sessions = {
    sendMessage: async (to: string, _id: string, text: string) => {
      sent.push({ to, text })
      // The manager journals the user message and opens the turn before handing over.
      log.append(to, { type: 'message.completed', messageId: randomUUID(), role: 'user', blocks: [{ type: 'text', text }], parentToolCallId: null })
      log.append(to, { type: 'turn.started' })
    },
  } as unknown as SessionManager
  const dispatched: Array<{ userId: string; notification: OutgoingNotification }> = []
  const notifications = { dispatch: async (userId: string, notification: OutgoingNotification) => { dispatched.push({ userId, notification }) } }
  const service = new UsageLimitResumeService(db, log, sessions, notifications)
  service.start({ warn: () => undefined } as never)
  t.after(() => service.stop())

  const prefs = (patch: { enabled?: boolean; maxHours?: number; message?: string }) =>
    db.insert(userSettings).values({ userId: 'owner', data: JSON.stringify({ usageLimitResume: { enabled: true, maxHours: 12, message: '', ...patch } }) })
      .onConflictDoUpdate({ target: userSettings.userId, set: { data: JSON.stringify({ usageLimitResume: { enabled: true, maxHours: 12, message: '', ...patch } }) } }).run()
  const usage = (resetsAt: number | null, status: 'rejected' | 'allowed' = 'rejected'): SillageEvent => ({
    type: 'usage.updated', costUsd: 0, inputTokens: 0, outputTokens: 0,
    rateLimit: { type: 'five_hour', status, utilization: 1, resetsAt },
  })
  const completed = (stopReason: string): SillageEvent => ({ type: 'turn.completed', stopReason, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 })
  const failedTurn = (id: string, resetsAt: number | null) => {
    log.append(id, { type: 'turn.started' })
    log.append(id, usage(resetsAt))
    log.append(id, { type: 'error', code: 'turn_failed', message: "You've hit your limit", recoverable: true })
    log.append(id, completed('success'))
  }
  const rows = (id: string) => db.select().from(usageLimitResumes).where(eq(usageLimitResumes.conversationId, id)).orderBy(usageLimitResumes.createdAt).all()
  const notices = (id: string) => log.read(id, 0, 1000).map((entry) => entry.event).filter((event) => event.type === 'agent.notice')
  const userMessage = (id: string, text: string) =>
    log.append(id, { type: 'message.completed', messageId: randomUUID(), role: 'user', blocks: [{ type: 'text', text }], parentToolCallId: null })
  return { db, log, service, sent, dispatched, prefs, usage, completed, failedTurn, rows, notices, userMessage }
}

test('usage limit: only a turn the limit stopped counts, and the account decides whether it resumes', async (t) => {
  const { db, log, service, sent, dispatched, prefs, usage, completed, failedTurn, rows, notices } = await harness(t)
  const soon = Date.now() + 60_000

  // A rejected limit the turn survived (overage) is not a stop.
  log.append(HUMAN, { type: 'turn.started' })
  log.append(HUMAN, usage(soon))
  log.append(HUMAN, completed('success'))
  assert.equal(rows(HUMAN).length, 0)
  // An error without a rejected limit is an ordinary failure.
  log.append(HUMAN, { type: 'turn.started' })
  log.append(HUMAN, { type: 'error', code: 'turn_failed', message: 'boom', recoverable: true })
  log.append(HUMAN, completed('error_during_execution'))
  assert.equal(rows(HUMAN).length, 0)

  // Off by default: the stop is reported, nothing is scheduled.
  failedTurn(HUMAN, soon)
  let [row] = rows(HUMAN)
  assert.equal(row!.status, 'skipped')
  assert.equal(row!.reason, 'disabled')
  assert.equal(row!.resumeAt, null)
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0]!.notification.kind, 'usageLimit')
  assert.equal(dispatched[0]!.notification.push.kind, 'usageLimit')
  assert.deepEqual(dispatched[0]!.notification.toast, {
    kind: 'usageLimit', conversationId: HUMAN, projectId: 'project', conversationTitle: 'Session 1', resetsAt: soon, resumeAt: null, reason: 'disabled',
  })
  const [notice] = notices(HUMAN)
  assert.equal(notice!.type === 'agent.notice' && notice.code, 'usage_limit_stop')
  assert.deepEqual(notice!.type === 'agent.notice' && notice.details, { resetsAt: soon, resumeAt: null, reason: 'disabled' })

  // Enabled: scheduled slightly after the reset, with the account's text.
  prefs({ enabled: true, message: 'Carry on.' })
  failedTurn(HUMAN, soon)
  row = rows(HUMAN).at(-1)
  assert.equal(row!.status, 'scheduled')
  assert.ok(row!.resumeAt! > soon && row!.resumeAt! <= soon + 60_000)
  assert.equal(row!.message, 'Carry on.')
  assert.equal(dispatched.at(-1)!.notification.toast!.kind === 'usageLimit' && dispatched.at(-1)!.notification.toast!.resumeAt, row!.resumeAt)

  // Not due yet: the pass sends nothing.
  await service.tick()
  assert.equal(sent.length, 0)

  // Due: resumed once, with the header the agent reads first.
  db.update(usageLimitResumes).set({ resumeAt: Date.now() - 1 }).where(eq(usageLimitResumes.id, row!.id)).run()
  await service.tick()
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.to, HUMAN)
  assert.equal(sent[0]!.text, resumeText('Carry on.'))
  assert.equal(rows(HUMAN).at(-1)!.status, 'resumed')
  assert.equal(notices(HUMAN).at(-1)!.type === 'agent.notice' && notices(HUMAN).at(-1)!.code, 'usage_limit_resumed')
  // Its own user message does not count as a person writing.
  assert.equal(rows(HUMAN).at(-1)!.supersededAt, null)

  // Stopping again on the limit without anyone writing: reported, not resumed twice.
  failedTurn(HUMAN, soon)
  row = rows(HUMAN).at(-1)
  assert.equal(row!.status, 'skipped')
  assert.equal(row!.reason, 'already_resumed')

  // Beyond the threshold: reported only.
  failedTurn(HUMAN, Date.now() + 13 * 3_600_000)
  assert.equal(rows(HUMAN).at(-1)!.reason, 'threshold')
  // No reset time: nothing to schedule.
  failedTurn(HUMAN, null)
  assert.equal(rows(HUMAN).at(-1)!.reason, 'unknown_reset')

  // Scheduled runs are only reported.
  failedTurn(TASK, soon)
  assert.equal(rows(TASK).at(-1)!.reason, 'schedule')
  assert.equal(dispatched.at(-1)!.notification.conversationId, TASK)
})

test('usage limit: writing, interrupting or archiving cancels a pending resume; the default text applies when empty', async (t) => {
  const { db, log, service, sent, prefs, failedTurn, rows, userMessage } = await harness(t)
  const soon = Date.now() + 60_000
  prefs({ enabled: true })

  // Someone wrote: cancelled, and a later stop may resume again.
  failedTurn(HUMAN, soon)
  userMessage(HUMAN, 'continue')
  assert.equal(rows(HUMAN).at(-1)!.status, 'cancelled')
  assert.equal(rows(HUMAN).at(-1)!.reason, 'user_message')

  // Interrupted before the reset.
  failedTurn(HUMAN, soon)
  log.append(HUMAN, { type: 'session.ended', reason: 'interrupted' })
  assert.equal(rows(HUMAN).at(-1)!.reason, 'interrupted')

  // Archived before the reset: found out at delivery time.
  failedTurn(HUMAN, soon)
  db.update(conversations).set({ archivedAt: Date.now() }).where(eq(conversations.id, HUMAN)).run()
  db.update(usageLimitResumes).set({ resumeAt: Date.now() - 1 }).where(eq(usageLimitResumes.status, 'scheduled')).run()
  await service.tick()
  assert.equal(rows(HUMAN).at(-1)!.reason, 'archived')
  assert.equal(sent.length, 0)
  db.update(conversations).set({ archivedAt: null }).where(eq(conversations.id, HUMAN)).run()

  // Busy when due: never interleave with someone else's turn.
  failedTurn(HUMAN, soon)
  db.update(conversations).set({ status: 'running' }).where(eq(conversations.id, HUMAN)).run()
  db.update(usageLimitResumes).set({ resumeAt: Date.now() - 1 }).where(eq(usageLimitResumes.status, 'scheduled')).run()
  await service.tick()
  assert.equal(rows(HUMAN).at(-1)!.reason, 'not_idle')
  db.update(conversations).set({ status: 'idle' }).where(eq(conversations.id, HUMAN)).run()

  // A resumed session someone wrote in afterwards may resume again on the next limit.
  failedTurn(HUMAN, soon)
  db.update(usageLimitResumes).set({ resumeAt: Date.now() - 1 }).where(eq(usageLimitResumes.status, 'scheduled')).run()
  await service.tick()
  assert.equal(sent.at(-1)!.text, resumeText(DEFAULT_USAGE_LIMIT_RESUME_MESSAGE), 'Empty preference falls back to the default text')
  userMessage(HUMAN, 'thanks, keep going')
  assert.ok(rows(HUMAN).at(-1)!.supersededAt)
  failedTurn(HUMAN, soon)
  assert.equal(rows(HUMAN).at(-1)!.status, 'scheduled')
})
