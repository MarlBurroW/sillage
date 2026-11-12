import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull, lte } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { conversations, usageLimitResumes, type Db, type UsageLimitResumeRow } from '@sillage/db'
import {
  conversationPath,
  DEFAULT_USAGE_LIMIT_RESUME_MESSAGE,
  USAGE_LIMIT_RESUMED_NOTICE,
  USAGE_LIMIT_STOP_NOTICE,
  type ContentBlock,
  type JournalEntry,
  type UsageLimitResumeReason,
  type UsageLimitStopDetails,
} from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'
import type { Notifications } from '../notifications/dispatcher.js'
import { readUserSettings } from '../settings/user-settings.js'
import type { SessionManager } from '../sessions/session-manager.js'

/** Minute precision suffices: the CLI's reset time is itself rounded. */
const TICK_MS = 30_000
const HOUR_MS = 3_600_000
/** Resume slightly after the announced reset: at the exact second the API may still refuse. */
const GRACE_MS = 60_000

/** What the current turn of a conversation has shown so far. */
interface TurnWatch {
  /** Latest reset time of a `rejected` limit seen during the turn; null when none was rejected. */
  rejectedResetsAt: number | null
  /** The CLI reported a rejected limit without a reset time. */
  rejected: boolean
  /** An error event occurred during the turn. */
  errored: boolean
}

/**
 * Resumes sessions that a subscription usage limit stopped mid-turn.
 *
 * Runners already translate the CLI's limit events into `usage.updated` with a `rejected` status
 * and a reset time, then end the turn on an error. This service reads those journal entries,
 * recognizes the combination, tells the user once, and when the account allows it schedules a
 * resume message for after the reset. Rows persist so a resume survives a daemon restart.
 *
 * Only a turn the limit stopped qualifies: a `rejected` status alone is not enough, since an
 * overage-enabled account keeps working after one. Scheduled runs are notified only, because the
 * next run starts from scratch. Anyone writing in the session cancels the resume, and a session
 * resumes at most once per limit unless someone wrote in between.
 */
export class UsageLimitResumeService {
  private readonly watches = new Map<string, TurnWatch>()
  /** Conversations whose resume message is being sent: their user message must not count as a person writing. */
  private readonly resuming = new Set<string>()
  private unsubscribe: (() => void) | null = null
  private timer: NodeJS.Timeout | null = null
  private logger: FastifyBaseLogger | null = null
  private ticking = false

  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
    private readonly sessions: Pick<SessionManager, 'sendMessage'>,
    private readonly notifications: Pick<Notifications, 'dispatch'>,
  ) {}

  start(logger: FastifyBaseLogger): void {
    this.logger = logger
    this.unsubscribe = this.log.subscribeAll((entry) => this.observe(entry))
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref()
    void this.tick()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Follows one conversation's turn through its journal; synchronous so the resolution never races the next event. */
  observe(entry: JournalEntry): void {
    const { conversationId, event } = entry
    try {
      switch (event.type) {
        case 'turn.started':
          this.watches.set(conversationId, { rejectedResetsAt: null, rejected: false, errored: false })
          return
        case 'usage.updated': {
          if (event.rateLimit?.status !== 'rejected') return
          const watch = this.watch(conversationId)
          watch.rejected = true
          if (event.rateLimit.resetsAt !== null) watch.rejectedResetsAt = Math.max(watch.rejectedResetsAt ?? 0, event.rateLimit.resetsAt)
          return
        }
        case 'error':
          // A deferred setting is journaled as an error but the turn goes on.
          if (event.code !== 'config_restart_deferred') this.watch(conversationId).errored = true
          return
        case 'turn.completed': {
          const watch = this.watches.get(conversationId)
          this.watches.delete(conversationId)
          if (!watch?.rejected) return
          if (!watch.errored && event.stopReason === 'success') return
          this.stopped(conversationId, watch.rejectedResetsAt, entry.ts)
          return
        }
        case 'message.completed':
          if (event.role === 'user') this.written(conversationId, event.blocks)
          return
        case 'session.ended':
          if (event.reason === 'interrupted') this.cancel(conversationId, 'interrupted')
          return
        default:
          return
      }
    } catch (err) {
      this.logger?.warn({ err, conversation: conversationId }, 'usage limit watch failed')
    }
  }

  private watch(conversationId: string): TurnWatch {
    let watch = this.watches.get(conversationId)
    if (!watch) {
      watch = { rejectedResetsAt: null, rejected: false, errored: false }
      this.watches.set(conversationId, watch)
    }
    return watch
  }

  /** A turn just died on the limit: decide, journal a notice, notify once. */
  private stopped(conversationId: string, resetsAt: number | null, now: number): void {
    const conversation = this.db
      .select({
        userId: conversations.userId,
        title: conversations.title,
        projectId: conversations.projectId,
        scheduleId: conversations.scheduleId,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get()
    if (!conversation) return

    // One open row per conversation: a second stop replaces a pending resume.
    this.cancel(conversationId, 'already_resumed')

    const prefs = readUserSettings(this.db, conversation.userId).usageLimitResume
    const latest = this.latest(conversationId)
    let reason: UsageLimitResumeReason | null = null
    if (conversation.scheduleId) reason = 'schedule'
    else if (!prefs.enabled) reason = 'disabled'
    else if (resetsAt === null) reason = 'unknown_reset'
    else if (resetsAt - now > prefs.maxHours * HOUR_MS) reason = 'threshold'
    else if (latest?.status === 'resumed' && latest.supersededAt === null) reason = 'already_resumed'

    const resumeAt = reason === null ? Math.max(resetsAt! + GRACE_MS, now + GRACE_MS) : null
    const message = reason === null ? prefs.message.trim() || DEFAULT_USAGE_LIMIT_RESUME_MESSAGE : null
    this.db
      .insert(usageLimitResumes)
      .values({
        id: randomUUID(),
        conversationId,
        userId: conversation.userId,
        resetsAt,
        resumeAt,
        status: reason === null ? 'scheduled' : 'skipped',
        reason,
        message,
        supersededAt: null,
        createdAt: now,
        resolvedAt: reason === null ? null : now,
      })
      .run()

    const details: UsageLimitStopDetails = { resetsAt, resumeAt, reason }
    this.log.append(conversationId, {
      type: 'agent.notice',
      code: USAGE_LIMIT_STOP_NOTICE,
      message: describeStop(details),
      level: 'warning',
      details,
    })

    void this.notifications
      .dispatch(conversation.userId, {
        kind: 'usageLimit',
        conversationId,
        push: {
          title: "Limite d'usage atteinte",
          body: conversation.title,
          url: conversationPath({ projectId: conversation.projectId, id: conversationId }),
          tag: `usage-limit-${conversationId}`,
          kind: 'usageLimit',
          resetsAt,
          resumeAt,
        },
        toast: {
          kind: 'usageLimit',
          conversationId,
          projectId: conversation.projectId,
          conversationTitle: conversation.title,
          resetsAt,
          resumeAt,
          reason,
        },
      })
      .catch((err) => this.logger?.warn({ err, conversation: conversationId }, 'usage limit notification failed'))
  }

  /** Someone wrote in the session: a pending resume is off, and a past resume may happen again. */
  private written(conversationId: string, blocks: ContentBlock[]): void {
    if (this.resuming.has(conversationId)) return
    const latest = this.latest(conversationId)
    if (!latest) return
    // A queued resume message reaches the journal after `sendMessage` returned: recognize it by
    // its text rather than treating it as a person writing.
    const text = blocks.find((block) => block.type === 'text')?.text ?? null
    if (latest.status === 'resumed' && latest.message !== null && text === resumeText(latest.message)) return
    if (latest.status === 'scheduled') this.resolve(latest, { status: 'cancelled', reason: 'user_message' })
    else if (latest.status === 'resumed' && latest.supersededAt === null) {
      this.db.update(usageLimitResumes).set({ supersededAt: Date.now() }).where(eq(usageLimitResumes.id, latest.id)).run()
    }
  }

  cancel(conversationId: string, reason: UsageLimitResumeReason): void {
    const latest = this.latest(conversationId)
    if (latest?.status === 'scheduled') this.resolve(latest, { status: 'cancelled', reason })
  }

  private latest(conversationId: string): UsageLimitResumeRow | undefined {
    return this.db
      .select()
      .from(usageLimitResumes)
      .where(eq(usageLimitResumes.conversationId, conversationId))
      .orderBy(desc(usageLimitResumes.createdAt), desc(usageLimitResumes.id))
      .limit(1)
      .get()
  }

  private resolve(row: UsageLimitResumeRow, patch: { status: UsageLimitResumeRow['status']; reason: UsageLimitResumeReason | null }): void {
    this.db.update(usageLimitResumes).set({ ...patch, resolvedAt: Date.now() }).where(eq(usageLimitResumes.id, row.id)).run()
  }

  /** Sends due resumes. Each one is checked against the session's current state: the journal may have missed a change while the daemon was down. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = Date.now()
      const due = this.db
        .select()
        .from(usageLimitResumes)
        .where(and(eq(usageLimitResumes.status, 'scheduled'), isNull(usageLimitResumes.resolvedAt), lte(usageLimitResumes.resumeAt, now)))
        .all()
      for (const row of due) await this.resume(row)
    } catch (err) {
      this.logger?.warn({ err }, 'usage limit resume pass failed')
    } finally {
      this.ticking = false
    }
  }

  private async resume(row: UsageLimitResumeRow): Promise<void> {
    const conversation = this.db
      .select({ status: conversations.status, archivedAt: conversations.archivedAt })
      .from(conversations)
      .where(eq(conversations.id, row.conversationId))
      .get()
    if (!conversation) {
      this.resolve(row, { status: 'cancelled', reason: 'archived' })
      return
    }
    if (conversation.archivedAt !== null) {
      this.resolve(row, { status: 'cancelled', reason: 'archived' })
      return
    }
    if (conversation.status === 'running' || conversation.status === 'awaiting_input') {
      this.resolve(row, { status: 'cancelled', reason: 'not_idle' })
      return
    }

    this.resuming.add(row.conversationId)
    try {
      // Resolve before sending: the send journals a user message, and `written` must find the row
      // already resumed should the `resuming` guard be cleared first.
      this.resolve(row, { status: 'resumed', reason: null })
      this.log.append(row.conversationId, {
        type: 'agent.notice',
        code: USAGE_LIMIT_RESUMED_NOTICE,
        message: 'Sillage resumed the session after the usage limit lifted.',
        level: 'info',
      })
      await this.sessions.sendMessage(row.conversationId, randomUUID(), resumeText(row.message ?? DEFAULT_USAGE_LIMIT_RESUME_MESSAGE))
    } catch (err) {
      // The next pass retries: the row goes back to scheduled.
      this.db.update(usageLimitResumes).set({ status: 'scheduled', resolvedAt: null }).where(eq(usageLimitResumes.id, row.id)).run()
      this.logger?.warn({ err, conversation: row.conversationId }, 'usage limit resume not delivered')
    } finally {
      this.resuming.delete(row.conversationId)
    }
  }
}

/** The agent reads the header before the account's text: it says who is speaking and why. */
export function resumeText(message: string): string {
  return `[Sillage — automatic resume: the usage limit that stopped your previous turn has been lifted]\n\n${message}`
}

/** Readable without the catalog, for log readers and exports; the thread translates from `details`. */
function describeStop(details: UsageLimitStopDetails): string {
  const lifted = details.resetsAt === null ? 'at an unknown time' : `at ${stamp(details.resetsAt)}`
  if (details.resumeAt !== null) return `The usage limit stopped this turn. It lifts ${lifted}; Sillage will resume the session at ${stamp(details.resumeAt)}.`
  return `The usage limit stopped this turn. It lifts ${lifted}; the session will not resume by itself (${details.reason}).`
}

function stamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
