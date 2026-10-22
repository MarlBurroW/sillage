import { createHmac, randomUUID } from 'node:crypto'
import { and, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm'
import {
  apiTaskOptions,
  apiTokens,
  conversations,
  webhookDeliveries,
  type ConversationRow,
  type Db,
} from '@sillage/db'
import type { JournalEntry, WebhookFailureReason, WebhookPayload } from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'
import type { SessionManager } from '../sessions/session-manager.js'

/** Task webhook delivery and response-deadline monitoring. Listen to all journal events but retain only API tasks whose token or task declares a URL. Persist deliveries before their first attempt so restarts retry unsent notifications, whose loss callers cannot detect. Always deliver regardless of humans viewing conversations: never inherit push `isWatched` filtering, designed for humans already at their screens rather than machine callers. */

/** Exponential retries: start at 30 s, multiply by four, cap at six hours (30 s, 2 min, 8 min, 32 min, ~2 h, 6 h, 6 h), covering about fifteen hours. After the final attempt, abandon delivery while retaining its record and latest error. */
const RETRY_BASE_MS = 30 * 1000
const RETRY_FACTOR = 4
const RETRY_CAP_MS = 6 * 60 * 60 * 1000
const RETRY_MAX_ATTEMPTS = 8

function retryDelayMs(attempts: number): number | null {
  if (attempts >= RETRY_MAX_ATTEMPTS) return null
  return Math.min(RETRY_BASE_MS * RETRY_FACTOR ** (attempts - 1), RETRY_CAP_MS)
}
const SCAN_INTERVAL_MS = 15 * 1000
const REQUEST_TIMEOUT_MS = 10 * 1000
/** Consumer replay window carried by signature timestamps. */

type PendingKind = 'permission' | 'question' | 'plan' | 'elicitation'

const REQUESTED_TYPES: Record<string, PendingKind | undefined> = {
  'permission.requested': 'permission',
  'question.requested': 'question',
  'plan.review_requested': 'plan',
  'elicitation.requested': 'elicitation',
}

const RESOLVED_TYPES = new Set([
  'permission.resolved',
  'question.resolved',
  'plan.review_resolved',
  'elicitation.resolved',
])

interface TaskTarget {
  conversation: ConversationRow
  tokenId: string
  url: string
  secret: string
  replyDeadlineSec: number
}

export class WebhookService {
  private unsubscribe: (() => void) | null = null
  private timer: NodeJS.Timeout | null = null
  private scanning = false
  /** Armed deadlines by requestId, lost on restart like requests themselves. */
  private readonly deadlines = new Map<string, NodeJS.Timeout>()
  /** Latest API message per conversation for correlating subsequent `task.completed`. In memory: after restart correlation is null, as the payload contract specifies. */
  private readonly lastClientMessage = new Map<string, string>()

  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
    private readonly sessions: SessionManager,
    /** Configured `server.publicUrl`; empty leaves payload links relative. */
    private readonly publicUrl: string,
  ) {}

  start(): void {
    this.unsubscribe = this.log.subscribeAll((entry) => this.onEvent(entry))
    this.timer = setInterval(() => void this.deliverDue(), SCAN_INTERVAL_MS)
    this.timer.unref()
    void this.deliverDue()
  }

  stop(): void {
    this.unsubscribe?.()
    if (this.timer) clearInterval(this.timer)
    for (const timer of this.deadlines.values()) clearTimeout(timer)
    this.deadlines.clear()
  }

  /** Called by v1 routes on every send to correlate the next turn. */
  trackMessage(conversationId: string, clientMessageId: string): void {
    this.lastClientMessage.set(conversationId, clientMessageId)
  }

  /** Stops requested by someone other than the originating token. No delivery when that token interrupted itself: it already knows. */
  taskStopped(conversationId: string, by: { kind: 'user' | 'token'; id: string; label: string }): void {
    const target = this.targetFor(conversationId)
    if (!target) return
    if (by.kind === 'token' && by.id === target.conversation.createdByTokenId) return

    this.enqueue(target, {
      type: 'task.stopped',
      by: { kind: by.kind, label: by.label },
    })
  }

  /** The service restarted and `recoverInterrupted` closed in-flight tasks. Without notifications here, every deployment would silently orphan callers' launched work. */
  sessionEnded(conversationIds: string[]): void {
    for (const id of conversationIds) {
      const target = this.targetFor(id)
      if (!target) continue
      this.enqueue(target, {
        type: 'task.failed',
        reason: 'session_ended',
        message: 'The server restarted; the CLI process and any open request died with it.',
      })
    }
  }

  /** Graceful-shutdown counterpart: SIGTERM calls `stopAll`, expiring requests before startup recovery. Persist deliveries while the database still responds and send after restart, exactly what persistence enables. Call before `stopAll` while statuses still identify in-flight work. */
  shutdownFlush(): void {
    const inFlight = this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          isNotNull(conversations.createdByTokenId),
          inArray(conversations.status, ['running', 'awaiting_input']),
        ),
      )
      .all()

    this.sessionEnded(inFlight.map((row) => row.id))
  }

  private onEvent(entry: JournalEntry): void {
    const type = entry.event.type
    const interesting =
      type === 'turn.completed' || type === 'error' || type in REQUESTED_TYPES || RESOLVED_TYPES.has(type)
    if (!interesting) return

    const target = this.targetFor(entry.conversationId)

    if (type in REQUESTED_TYPES) {
      const requested = entry.event as { requestId: string }
      // Arm deadlines even without webhook URLs: they protect session capacity,
      // not notifications.
      const blocking = !(entry.event.type === 'question.requested' && entry.event.blocking === false)
      if (blocking) this.armDeadline(entry.conversationId, requested.requestId)
      if (target) {
        const deadline = this.deadlineFor(entry.conversationId)
        this.enqueue(target, {
          type: 'task.awaiting_input',
          seq: entry.seq,
          pending: {
            kind: REQUESTED_TYPES[type]!,
            requestId: requested.requestId,
            event: entry.event,
          },
          ...(blocking && deadline > 0 ? { replyDeadlineAt: entry.ts + deadline * 1000 } : {}),
        })
      }
      return
    }

    if (RESOLVED_TYPES.has(type)) {
      const resolved = entry.event as { requestId: string }
      this.disarmDeadline(resolved.requestId)
      return
    }

    if (!target) return

    if (type === 'turn.completed') {
      // Turns closing with background work are not finished: the CLI wakes when that
      // work completes and starts another turn. Delivering here
      // would make callers conclude prematurely (observed in the first real trial);
      // 'ignore this' deliveries waste tokens, so
      // stay silent and let final-turn delivery report the actual end.
      const backgroundJobs = this.backgroundJobCount(entry.conversationId)
      if (backgroundJobs > 0) return

      const completed = entry.event as { stopReason: string | null }
      const clientMessageId = this.lastClientMessage.get(entry.conversationId) ?? null
      this.lastClientMessage.delete(entry.conversationId)
      this.enqueue(target, {
        type: 'task.completed',
        seq: entry.seq,
        clientMessageId,
        stopReason: completed.stopReason ?? 'unknown',
        lastMessage: this.lastAssistantText(entry.conversationId),
        backgroundJobs,
      })
      return
    }

    // `error`: deliver only failures terminating tasks. Recoverable errors remain
    // in journals as in the interface.
    const error = entry.event as { code?: string; message?: string; recoverable?: boolean }
    if (error.recoverable === false || error.code === 'runner_failed') {
      this.enqueue(target, {
        type: 'task.failed',
        seq: entry.seq,
        reason: 'runner_failed',
        message: error.message,
      })
    }
  }

  // Deadlines

  private armDeadline(conversationId: string, requestId: string): void {
    const seconds = this.deadlineFor(conversationId)
    if (seconds <= 0) return

    this.disarmDeadline(requestId)
    const timer = setTimeout(() => {
      this.deadlines.delete(requestId)
      void this.expireReply(conversationId, requestId)
    }, seconds * 1000)
    timer.unref()
    this.deadlines.set(requestId, timer)
  }

  private disarmDeadline(requestId: string): void {
    const timer = this.deadlines.get(requestId)
    if (!timer) return
    clearTimeout(timer)
    this.deadlines.delete(requestId)
  }

  /** Conversation deadline in seconds; 0 outside API tasks. */
  private deadlineFor(conversationId: string): number {
    const options = this.db
      .select({ replyDeadlineSec: apiTaskOptions.replyDeadlineSec })
      .from(apiTaskOptions)
      .where(eq(apiTaskOptions.conversationId, conversationId))
      .get()
    return options?.replyDeadlineSec ?? 0
  }

  /** Nobody answered before the deadline: reject requests, interrupt to release session capacity, and notify callers. 'As long as needed' suits humans returning to screens; machine callers may never return. */
  private async expireReply(conversationId: string, requestId: string): Promise<void> {
    // Null like `expireAll`: nobody decided, and `permission_requests.decided_by`
    // references `users.id`, so any other value violates its constraint.
    const decidedBy = null
    const refused =
      this.sessions.resolvePermission(conversationId, requestId, {
        decision: 'denied',
        scope: 'once',
        decidedBy,
      }) ||
      this.sessions.answerQuestion(conversationId, requestId, {
        status: 'cancelled',
        answers: {},
        decidedBy,
      }) ||
      this.sessions.resolveElicitation(conversationId, requestId, {
        action: 'cancel',
        content: {},
        decidedBy,
      }) ||
      this.sessions.reviewPlan(conversationId, requestId, {
        decision: 'rejected',
        followUpMode: null,
        decidedBy,
      })

    if (!refused) return
    await this.sessions.interrupt(conversationId)

    const target = this.targetFor(conversationId)
    if (!target) return
    this.enqueue(target, {
      type: 'task.failed',
      reason: 'reply_deadline_exceeded' satisfies WebhookFailureReason,
      message: `No reply to request ${requestId} before the deadline; the request was refused and the task interrupted.`,
    })
  }

  // Delivery

  /** Conversation target: API tasks declaring a URL, otherwise none. */
  private targetFor(conversationId: string): TaskTarget | null {
    const row = this.db
      .select({ conversation: conversations, token: apiTokens, options: apiTaskOptions })
      .from(conversations)
      .innerJoin(apiTokens, eq(apiTokens.id, conversations.createdByTokenId))
      .leftJoin(apiTaskOptions, eq(apiTaskOptions.conversationId, conversations.id))
      .where(eq(conversations.id, conversationId))
      .get()

    if (!row) return null
    const url = row.options?.webhookUrl ?? row.token.webhookUrl
    if (!url || !row.token.webhookSecret) return null

    return {
      conversation: row.conversation,
      tokenId: row.token.id,
      url,
      secret: row.token.webhookSecret,
      replyDeadlineSec: row.options?.replyDeadlineSec ?? 0,
    }
  }

  /** Open background work from the latest `background.updated`. CLIs publish full lists on every change, so the last journal entry is current state without pairing events. */
  private backgroundJobCount(conversationId: string): number {
    const [latest] = this.log.latest(conversationId, ['background.updated'], 1)
    if (!latest) return 0
    const event = latest.event as { tasks?: unknown[] }
    return event.tasks?.length ?? 0
  }

  private lastAssistantText(conversationId: string): string | null {
    return this.log.lastAssistantText(conversationId)
  }

  private enqueue(
    target: TaskTarget,
    partial: Partial<WebhookPayload> & { type: WebhookPayload['type'] },
  ): void {
    const now = Date.now()
    const payload: WebhookPayload = {
      taskId: target.conversation.id,
      projectId: target.conversation.projectId,
      seq: target.conversation.lastSeq,
      ts: now,
      clientMessageId: null,
      status: target.conversation.status,
      title: target.conversation.title,
      url: `${this.publicUrl.replace(/\/+$/, '')}/p/${target.conversation.projectId}/c/${target.conversation.id}`,
      ...partial,
    }

    this.db
      .insert(webhookDeliveries)
      .values({
        id: randomUUID(),
        tokenId: target.tokenId,
        conversationId: target.conversation.id,
        url: target.url,
        type: payload.type,
        payload: JSON.stringify(payload),
        attempts: 0,
        nextAttemptAt: now,
        deliveredAt: null,
        lastError: null,
        createdAt: now,
      })
      .run()

    void this.deliverDue()
  }

  /** Attempts all due deliveries, one pass at a time. */
  private async deliverDue(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      const due = this.db
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            isNull(webhookDeliveries.deliveredAt),
            isNotNull(webhookDeliveries.nextAttemptAt),
            lte(webhookDeliveries.nextAttemptAt, Date.now()),
          ),
        )
        .limit(50)
        .all()

      for (const delivery of due) {
        await this.attempt(delivery.id, delivery.tokenId, delivery.url, delivery.payload, delivery.attempts)
      }
    } finally {
      this.scanning = false
    }
  }

  private async attempt(
    id: string,
    tokenId: string,
    url: string,
    body: string,
    attempts: number,
  ): Promise<void> {
    const secret = this.db
      .select({ webhookSecret: apiTokens.webhookSecret })
      .from(apiTokens)
      .where(eq(apiTokens.id, tokenId))
      .get()?.webhookSecret

    let error: string | null = null
    if (!secret) {
      error = 'webhook secret no longer exists'
    } else {
      try {
        const ts = Date.now()
        const signature = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Sillage-Signature': `t=${ts},v1=${signature}`,
            'X-Sillage-Delivery': id,
          },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (response.ok) {
          this.db
            .update(webhookDeliveries)
            .set({ deliveredAt: Date.now(), lastError: null })
            .where(eq(webhookDeliveries.id, id))
            .run()
          return
        }
        error = `HTTP ${response.status}`
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
    }

    // On failure, retry according to schedule or abandon while retaining the record.
    const nextDelay = retryDelayMs(attempts + 1)
    this.db
      .update(webhookDeliveries)
      .set({
        attempts: attempts + 1,
        lastError: error,
        nextAttemptAt: nextDelay === null ? null : Date.now() + nextDelay,
      })
      .where(eq(webhookDeliveries.id, id))
      .run()
  }
}
