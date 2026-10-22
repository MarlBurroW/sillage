import { and, asc, count, desc, eq, gt, isNotNull, isNull } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { randomUUID } from 'node:crypto'
import {
  conversations,
  events,
  sessionMessages,
  sessionWatches,
  type Db,
  type SessionMessageRow,
} from '@sillage/db'
import { formatSessionMessage } from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'
import type { SessionManager } from './session-manager.js'

/** Delivers inter-session messages. MCP deposits messages in databases because it lacks runners; relay sweeps inject by steering working recipients or ordinary messages waking idle ones. Also handles `notify_when_done` watches, turning session completions into messages. Poll because processes share only SQLite without cross-process notifications. Two seconds are negligible beside agent turns, and queries use indexes. */

const POLL_MS = 2000

/** Reply depth beyond which messages no longer wake idle recipients. Polite agents otherwise thank each other forever, spending unattended tokens. Count `reply_to` chains; hold beyond the limit for human delivery/dismissal in recipient conversations. Must match `apps/server/src/mcp/sillage-mcp.mjs`, which warns senders immediately. */
export const MAX_HOPS = 6

/** Recipient wakeups per hour across chains. Previous safeguards depend on optional `reply_to`; this unconditional limit makes recipients awakened six times per hour await human intervention. Keep MCP constants consistent. */
export const WAKES_PER_HOUR = 6

/** Maximum delivery/watch age. Day-old messages no longer describe current state and would interrupt unrelated work like fresh instructions. Remain readable through tools. */
const STALE_MS = 24 * 60 * 60 * 1000

/** Completed-session final messages quoted to waiting sessions. */
const DONE_EXCERPT_CHARS = 1500

type Outcome =
  | { via: 'steer' | 'queue' | 'wake' | 'failed' | 'skipped' }
  | { via: 'held'; reason: 'loop' | 'rate' }

const STATUS_WORDS: Record<string, string> = {
  idle: 'au repos',
  interrupted: 'interrompue',
  error: 'en erreur',
}

export class SessionRelay {
  private timer: NodeJS.Timeout | null = null
  /** Never start sweeps while previous ones still await CLIs. */
  private busy = false
  /** Set by `start`: logger belongs to the subsequently built application. */
  private logger: FastifyBaseLogger | null = null

  constructor(
    private readonly db: Db,
    private readonly sessions: SessionManager,
    private readonly log: EventLog,
  ) {}

  start(logger: FastifyBaseLogger): void {
    this.logger = logger
    this.timer = setInterval(() => void this.sweep(), POLL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async sweep(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      this.fireWatches()

      const pending = this.db
        .select()
        .from(sessionMessages)
        .where(isNull(sessionMessages.deliveredAt))
        .orderBy(asc(sessionMessages.createdAt))
        .limit(100)
        .all()

      for (const message of pending) {
        if (message.createdAt < Date.now() - STALE_MS) {
          this.settle(message.id, message.kind === 'broadcast' ? 'skipped' : 'expired')
          continue
        }
        await this.attempt(message, false)
      }

      this.closeHeld()
    } finally {
      this.busy = false
    }
  }

  /** Human-requested delivery of held messages bypasses safeguards because those prevent unattended loops and someone has now reviewed the exchange. */
  async release(conversationId: string, messageId: string): Promise<boolean> {
    const message = this.pendingFor(conversationId, messageId)
    if (!message) return false
    await this.attempt(message, true)
    this.closeHeld()
    return true
  }

  discard(conversationId: string, messageId: string): boolean {
    const message = this.pendingFor(conversationId, messageId)
    if (!message) return false
    this.settle(message.id, 'discarded')
    this.closeHeld()
    return true
  }

  private pendingFor(conversationId: string, messageId: string) {
    return this.db
      .select()
      .from(sessionMessages)
      .where(
        and(
          eq(sessionMessages.id, messageId),
          eq(sessionMessages.toConversationId, conversationId),
          isNull(sessionMessages.deliveredAt),
        ),
      )
      .get()
  }

  private async attempt(message: SessionMessageRow, force: boolean): Promise<void> {
    const outcome = await this.deliver(message, force).catch((err: unknown): Outcome => {
      this.logger?.warn({ err, message: message.id }, 'message entre sessions non remis')
      return { via: 'failed' }
    })

    if (outcome.via !== 'held') {
      this.settle(message.id, outcome.via)
      return
    }

    // Announce once: messages are reconsidered every sweep and daemon restarts
    // must not duplicate conversation notices.
    if (message.heldAt !== null) return
    this.db
      .update(sessionMessages)
      .set({ heldAt: Date.now() })
      .where(eq(sessionMessages.id, message.id))
      .run()
    this.log.append(message.toConversationId, {
      type: 'session_message.held',
      messageId: message.id,
      text: this.frame(message),
      reason: outcome.reason,
    })
  }

  private settle(id: string, via: NonNullable<SessionMessageRow['deliveredVia']>): void {
    this.db
      .update(sessionMessages)
      .set({ deliveredAt: Date.now(), deliveredVia: via })
      // The recipient may read through the tool during delivery: that marking is
      // correct, and must not be overwritten.
      .where(and(eq(sessionMessages.id, id), isNull(sessionMessages.deliveredAt)))
      .run()
  }

  /** Closes held notices after delivery through any path. Sweep because MCP `read_session_messages` may mark them read without journal access. Reset `heldAt` after closure to keep announcements unique. */
  private closeHeld(): void {
    const closed = this.db
      .select()
      .from(sessionMessages)
      .where(and(isNotNull(sessionMessages.heldAt), isNotNull(sessionMessages.deliveredAt)))
      .all()

    for (const message of closed) {
      const via = message.deliveredVia
      this.log.append(message.toConversationId, {
        type: 'session_message.released',
        messageId: message.id,
        reason: via === 'read' || via === 'discarded' || via === 'expired' ? via : 'delivered',
      })
      this.db
        .update(sessionMessages)
        .set({ heldAt: null })
        .where(eq(sessionMessages.id, message.id))
        .run()
    }
  }

  private async deliver(message: SessionMessageRow, force: boolean): Promise<Outcome> {
    const recipient = this.conversation(message.toConversationId)
    if (!recipient || recipient.archivedAt !== null) return { via: 'failed' }

    const text = this.frame(message)

    // Use message IDs as client IDs so manager deduplication absorbs retries
    // after delivery-marker write failures.
    if (recipient.status === 'running') {
      if (await this.sessions.steer(recipient.id, message.id, text)) return { via: 'steer' }
      // If turns finish between status reads and steering, send ordinary messages,
      // which queue if another turn still runs.
      const now = this.conversation(recipient.id)
      if (now?.status === 'running' || now?.status === 'awaiting_input') {
        await this.sessions.sendMessage(recipient.id, message.id, text)
        return { via: 'queue' }
      }
    }

    // Pending requests put messages behind human answers.
    if (recipient.status === 'awaiting_input') {
      await this.sessions.sendMessage(recipient.id, message.id, text)
      return { via: 'queue' }
    }

    // Announcements apply only to sessions working at the time: waking idle sessions
    // solely to announce service restarts makes no sense.
    if (message.kind === 'broadcast') return { via: 'skipped' }

    // Explicitly requested completion notices wake sessions without rate counting.
    if (message.kind === 'message' && !force) {
      const held = this.holdReason(message)
      if (held) return { via: 'held', reason: held }
    }
    await this.sessions.sendMessage(recipient.id, message.id, text)
    return { via: 'wake' }
  }

  private holdReason(message: SessionMessageRow): 'loop' | 'rate' | null {
    if (this.hops(message) >= MAX_HOPS) return 'loop'

    const [row] = this.db
      .select({ total: count() })
      .from(sessionMessages)
      .where(
        and(
          eq(sessionMessages.toConversationId, message.toConversationId),
          eq(sessionMessages.kind, 'message'),
          eq(sessionMessages.deliveredVia, 'wake'),
          gt(sessionMessages.deliveredAt, Date.now() - 60 * 60 * 1000),
        ),
      )
      .all()
    return (row?.total ?? 0) >= WAKES_PER_HOUR ? 'rate' : null
  }

  /** Bounded reply-chain length: counting beyond limits adds no value. */
  private hops(message: SessionMessageRow): number {
    let depth = 0
    let parent = message.replyTo
    while (parent && depth < MAX_HOPS) {
      depth++
      parent =
        this.db
          .select({ replyTo: sessionMessages.replyTo })
          .from(sessionMessages)
          .where(eq(sessionMessages.id, parent))
          .get()?.replyTo ?? null
    }
    return depth
  }

  /** Deposits `done` messages for watches whose targets finished: no turn, background work, loop or pending requests, which are merely pauses. Messages then follow normal delivery in the same sweep. */
  private fireWatches(): void {
    const open = this.db.select().from(sessionWatches).where(isNull(sessionWatches.firedAt)).all()

    for (const watch of open) {
      const fire = () =>
        this.db
          .update(sessionWatches)
          .set({ firedAt: Date.now() })
          .where(eq(sessionWatches.id, watch.id))
          .run()

      if (watch.createdAt < Date.now() - STALE_MS) {
        fire()
        continue
      }

      const target = this.db
        .select({
          status: conversations.status,
          background: conversations.backgroundCount,
          loops: conversations.loopCount,
          archivedAt: conversations.archivedAt,
        })
        .from(conversations)
        .where(eq(conversations.id, watch.targetConversationId))
        .get()

      const working =
        target &&
        target.archivedAt === null &&
        (target.status === 'running' ||
          target.status === 'awaiting_input' ||
          target.background > 0 ||
          target.loops > 0)
      if (working) continue

      const body = !target
        ? "Cette session n'existe plus."
        : target.archivedAt !== null
          ? 'Cette session a été archivée.'
          : this.doneBody(watch.targetConversationId, target.status)

      this.db
        .insert(sessionMessages)
        .values({
          id: randomUUID(),
          projectId: watch.projectId,
          fromConversationId: watch.targetConversationId,
          toConversationId: watch.watcherConversationId,
          kind: 'done',
          body,
          createdAt: Date.now(),
        })
        .run()
      fire()
    }
  }

  private doneBody(conversationId: string, status: string): string {
    const state = `La session est ${STATUS_WORDS[status] ?? status}.`
    const last = this.lastAgentText(conversationId)
    if (!last) return `${state} Elle n'a laissé aucun message.`

    const clipped =
      last.length > DONE_EXCERPT_CHARS ? `${last.slice(0, DONE_EXCERPT_CHARS)}\n[...]` : last
    return `${state} Son dernier message :\n\n${clipped
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}`
  }

  /** Latest main-agent conversation text excluding subagents. */
  private lastAgentText(conversationId: string): string | null {
    const rows = this.db
      .select({ payload: events.payload })
      .from(events)
      .where(
and(eq(events.conversationId, conversationId), eq(events.type, 'message.completed')),
      )
      .orderBy(desc(events.seq))
      .limit(30)
      .all()

    for (const row of rows) {
      const event = JSON.parse(row.payload) as {
        role?: string
        parentToolCallId?: string | null
        blocks?: { type: string; text?: string }[]
      }
      if (event.role !== 'assistant' || event.parentToolCallId) continue
      const text = (event.blocks ?? [])
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text) return text
    }
    return null
  }

  private conversation(id: string) {
    return this.db
      .select({
        id: conversations.id,
        title: conversations.title,
        agent: conversations.agent,
        status: conversations.status,
        archivedAt: conversations.archivedAt,
      })
      .from(conversations)
      .where(eq(conversations.id, id))
      .get()
  }

  /** Message as read by its recipient; see formatSessionMessage. */
  private frame(message: SessionMessageRow): string {
    const sender = this.conversation(message.fromConversationId)
    return formatSessionMessage({
      kind: message.kind,
      from: message.fromConversationId,
      title: sender?.title ?? message.fromConversationId,
      agent: sender?.agent ?? '?',
      messageId: message.id,
      body: message.body,
    })
  }
}
