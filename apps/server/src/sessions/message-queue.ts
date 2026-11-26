import { randomUUID } from 'node:crypto'
import type { EventLog } from '../events/event-log.js'
import type { OutgoingAttachment } from '../agents/types.js'

/** Message written during a turn, waiting for its completion. */
export interface QueuedMessage {
  queueId: string
  clientMessageId: string
  text: string
  attachments: OutgoingAttachment[]
  mentions: string[]
  skills: string[]
}

/** Send deduplication window (invariant I5). See sendMessage(). */
const DEDUPE_TTL_MS = 5 * 60 * 1000

/**
 * Pending messages per conversation and the journal events that mirror them. When a message leaves
 * (sent, steered, cancelled, expired) is the session manager's decision; this keeps the list and
 * the journal in step.
 */
export class MessageQueue {
  /** Pending messages per conversation, memory-only: messages never reaching CLIs need not survive restarts, and journals already allow clean closure on recovery (see `expireQueuedMessages`). */
  private readonly queues = new Map<string, QueuedMessage[]>()

  constructor(private readonly log: EventLog) {}

  has(conversationId: string): boolean {
    return this.queues.has(conversationId)
  }

  /** Queues a message behind the current turn and journals it. */
  push(conversationId: string, message: Omit<QueuedMessage, 'queueId'>): void {
    const queueId = randomUUID()
    const queue = this.queues.get(conversationId) ?? []
    queue.push({ queueId, ...message })
    this.queues.set(conversationId, queue)

    this.log.append(conversationId, {
      type: 'message.queued',
      queueId,
      text: message.text,
      attachmentCount: message.attachments.length,
    })
  }

  /** Takes the first queued message, journaled as sent. */
  shift(conversationId: string): QueuedMessage | undefined {
    const queue = this.queues.get(conversationId)
    const next = queue?.shift()
    if (!queue || !next) return undefined
    if (queue.length === 0) this.queues.delete(conversationId)

    this.log.append(conversationId, {
      type: 'message.dequeued',
      queueId: next.queueId,
      reason: 'sent',
    })
    return next
  }

  /** Removes a queued message without journaling it, and returns how to put it back at its position. */
  take(conversationId: string, queueId: string): { entry: QueuedMessage; restore: () => void } | null {
    const queue = this.queues.get(conversationId)
    const entry = queue?.find((item) => item.queueId === queueId)
    if (!queue || !entry) return null

    const index = queue.indexOf(entry)
    queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(conversationId)

    return {
      entry,
      restore: () => {
        const restored = this.queues.get(conversationId) ?? []
        restored.splice(index, 0, entry)
        this.queues.set(conversationId, restored)
      },
    }
  }

  /** Whether a message is queued, without touching it. */
  contains(conversationId: string, queueId: string): boolean {
    return this.queues.get(conversationId)?.some((item) => item.queueId === queueId) ?? false
  }

  /** Removes queued messages before sending. */
  cancel(conversationId: string, queueId: string): boolean {
    const queue = this.queues.get(conversationId)
    const index = queue?.findIndex((entry) => entry.queueId === queueId) ?? -1
    if (!queue || index === -1) return false

    queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(conversationId)

    this.log.append(conversationId, {
      type: 'message.dequeued',
      queueId,
      reason: 'cancelled',
    })
    return true
  }

  /** Pending messages that can no longer depart: journaled as expired, rather than lost silently at the next message. */
  expire(conversationId: string): void {
    for (const entry of this.queues.get(conversationId) ?? []) {
      this.log.append(conversationId, { type: 'message.dequeued', queueId: entry.queueId, reason: 'expired' })
    }
    this.queues.delete(conversationId)
  }

  /** Forgets the queue without journaling: for messages the journal already closed. */
  discard(conversationId: string): void {
    this.queues.delete(conversationId)
  }
}

/** Client message IDs seen recently, so network retries do not send twice (invariant I5). */
export class ClientMessageDedupe {
  private readonly recent = new Map<string, number>()

  /** Records client message IDs and reports whether new (invariant I5). Memory windows suffice because duplicates are network retries seconds apart, never other processes. */
  claim(conversationId: string, clientMessageId: string): boolean {
    const key = `${conversationId}:${clientMessageId}`
    const now = Date.now()
    for (const [seen, ts] of this.recent) {
      if (now - ts > DEDUPE_TTL_MS) this.recent.delete(seen)
    }
    if (this.recent.has(key)) return false
    this.recent.set(key, now)
    return true
  }

  /** Releases claimed but undelivered IDs when sends fail before reaching CLIs, so legitimate retries are not swallowed as duplicates. */
  release(conversationId: string, clientMessageId: string): void {
    this.recent.delete(`${conversationId}:${clientMessageId}`)
  }
}
