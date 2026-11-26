import { eq, gt, or } from 'drizzle-orm'
import { conversations, permissionRequests, type Db } from '@sillage/db'
import type { ConversationMetrics } from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'
import { conversationMetrics } from '../conversations/metrics.js'

/**
 * Journal and row bookkeeping shared by the session manager and its collaborators: closing what a
 * vanished runner, a cut turn or a daemon restart leaves open. Free functions over the journal and
 * the database, holding no state of their own.
 */

/** Closes unanswered requests in journals. Rendering folds know only journals; without these events, pre-shutdown questions and permissions would remain pending with buttons reaching nobody. */
export function expireOpenPrompts(log: EventLog, conversationId: string): void {
  for (const { kind, requestId } of log.openPrompts(conversationId)) {
    if (kind === 'permission') {
      log.append(conversationId, {
        type: 'permission.resolved',
        requestId,
        decision: 'expired',
        scope: 'once',
        decidedBy: null,
      })
    } else if (kind === 'elicitation') {
      log.append(conversationId, {
        type: 'elicitation.resolved',
        requestId,
        status: 'expired',
        content: {},
        decidedBy: null,
      })
    } else if (kind === 'question') {
      log.append(conversationId, {
        type: 'question.resolved',
        requestId,
        status: 'expired',
        answers: {},
        decidedBy: null,
      })
    } else {
      log.append(conversationId, {
        type: 'plan.review_resolved',
        requestId,
        decision: 'expired',
        followUpMode: null,
        decidedBy: null,
      })
    }
  }
}

/** Closes messages left queued at daemon shutdown. Memory queues are lost; without events, replay would show them pending forever for sends that cannot happen. */
export function expireQueuedMessages(log: EventLog, conversationId: string): void {
  for (const queueId of log.openQueuedMessages(conversationId)) {
    log.append(conversationId, { type: 'message.dequeued', queueId, reason: 'expired' })
  }
}

/** Clears detached work when runner processes leave. Background work and loops belong to CLI processes and no longer exist; otherwise nonzero row counts would make conversations appear active forever. */
export function clearActivity(db: Db, conversationId: string): void {
  db
    .update(conversations)
    .set({ backgroundCount: 0, loopCount: 0 })
    .where(eq(conversations.id, conversationId))
    .run()
}

/** Journals detached-work closure when processes leave, complementing `clearActivity`. Row resets suffice for database-reading sidebars but journal-only pages need events (invariant I2); otherwise final CLI lists show dead dev servers as alive forever. Write now instead of waiting for asynchronous abort-driven `session.ended`, which daemon shutdown may preempt. Close each task explicitly rather than silently empty lists: shells may survive hard daemon-only kills outside cgroup termination, and history must say work ended with sessions rather than normally. */
export function closeDetachedWork(log: EventLog, conversationId: string, hadLoops: boolean): void {
  const live = log.openBackgroundTasks(conversationId)
  for (const task of live) {
    log.append(conversationId, {
      type: 'task.completed',
      taskId: task.id,
      status: 'stopped',
      summary: "Arrêté avec la session : le process CLI qui le portait s'est terminé.",
      durationMs: null,
      ambient: false,
    })
  }
  if (live.length > 0) log.append(conversationId, { type: 'background.updated', tasks: [] })
  // Loops die with processes too; CLIs list them only on demand,
  // so nothing else clears their last known list.
  if (hadLoops) log.append(conversationId, { type: 'loops.updated', loops: [] })
}

/** Journals the end of a turn the journal still shows as open, so the thread stops showing it as running. No-op when the last turn already ended. */
export function closeOpenTurn(log: EventLog, conversationId: string, stopReason: 'interrupted' | 'failed'): void {
  try {
    const last = log.latest(conversationId, ['turn.started', 'turn.completed', 'session.ended'], 1)[0]
    if (last?.event.type !== 'turn.started') return
    log.append(conversationId, { type: 'turn.completed', stopReason, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })
  } catch (err) {
    console.error(`sillage: closing the open turn of ${conversationId} failed`, err)
  }
}

/** What a turn cut by the daemon leaves in the journal and the row, as `recoverInterrupted` writes it after a crash. */
export function closeInterruptedTurn(db: Db, log: EventLog, conversationId: string, message: string): void {
  log.append(conversationId, { type: 'error', code: 'daemon_restarted', message, recoverable: true })
  expireOpenPrompts(log, conversationId)
  expireQueuedMessages(log, conversationId)
  log.append(conversationId, { type: 'session.ended', reason: 'interrupted' })
  db.update(conversations).set({ status: 'interrupted' }).where(eq(conversations.id, conversationId)).run()
}

/** At startup no conversations can legitimately run: runners died with the previous process. Leaving `running` would misrepresent state and block messages. */
export function recoverInterrupted(db: Db, log: EventLog): string[] {
  const stale = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.status, 'running'))
    .all()

  const awaiting = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.status, 'awaiting_input'))
    .all()

  // Read before writes: resets below erase information needed to identify
  // conversations with detached work.
  const detached = new Map(
    db
      .select({ id: conversations.id, loops: conversations.loopCount })
      .from(conversations)
      .where(or(gt(conversations.backgroundCount, 0), gt(conversations.loopCount, 0)))
      .all()
      .map((row) => [row.id, row.loops > 0]),
  )

  for (const row of [...stale, ...awaiting]) {
    log.append(row.id, {
      type: 'error',
      code: 'daemon_restarted',
      // Web clients translate codes; English messages serve journal readers without
      // catalogs, including MCP and search.
      message: 'The daemon restarted during this conversation. The agent was interrupted.',
      recoverable: true,
    })
    expireOpenPrompts(log, row.id)
    expireQueuedMessages(log, row.id)
    closeDetachedWork(log, row.id, detached.get(row.id) ?? false)
    detached.delete(row.id)
    log.append(row.id, { type: 'session.ended', reason: 'interrupted' })
    db
      .update(conversations)
      .set({ status: 'interrupted' })
      .where(eq(conversations.id, row.id))
      .run()
  }

  // Background work outlives turns, so idle conversations may still carry it.
  // Their CLI processes died with the daemon too. These were not interrupted
  // mid-turn: emit neither errors nor status changes,
  // only closure for work no longer running.
  for (const [conversationId, hadLoops] of detached) {
    closeDetachedWork(log, conversationId, hadLoops)
  }

  // Conversations may already be idle, but their forms lost the runner
  // that could deliver answers.
  for (const conversationId of log.openAsyncQuestionConversationIds()) {
    expireOpenPrompts(log, conversationId)
  }

  db
    .update(permissionRequests)
    .set({ status: 'expired', decidedAt: Date.now() })
    .where(eq(permissionRequests.status, 'pending'))
    .run()

  // Database counterpart to journal closure above: sidebars read rows,
  // pages read journals, and both must agree.
  db
    .update(conversations)
    .set({ backgroundCount: 0, loopCount: 0 })
    .where(or(gt(conversations.backgroundCount, 0), gt(conversations.loopCount, 0)))
    .run()

  return [...stale, ...awaiting].map((row) => row.id)
}

/** The row-backed part of a status broadcast: last notable event and metrics. */
export function statusSnapshot(db: Db, conversationId: string): { lastNotableSeq: number; metrics: ConversationMetrics } {
  // Reread `lastNotableSeq` and metrics on every broadcast: journals are written
  // before status changes so values are fresh, and transitions occur only a few
  // times per turn. No additional
  // in-memory counters are needed.
  const row = db
    .select({
      lastNotableSeq: conversations.lastNotableSeq,
      turnCount: conversations.turnCount,
      journalBytes: conversations.journalBytes,
      contextUsedTokens: conversations.contextUsedTokens,
      contextMaxTokens: conversations.contextMaxTokens,
      model: conversations.model,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get()

  return {
    lastNotableSeq: row?.lastNotableSeq ?? 0,
    metrics: conversationMetrics(
      row ?? {
        turnCount: 0,
        journalBytes: 0,
        contextUsedTokens: null,
        contextMaxTokens: null,
        model: null,
      },
    ),
  }
}
