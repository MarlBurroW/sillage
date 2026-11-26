import { randomUUID } from 'node:crypto'
import type { ConversationRow } from '@sillage/db'
import type { ConversationStatus } from '@sillage/protocol'
import { describeOutgoingMessage } from '../agents/outgoing.js'
import type { OutgoingAttachment, OutgoingMention } from '../agents/types.js'
import type { EventLog } from '../events/event-log.js'
import type { MessageQueue } from './message-queue.js'
import type { RunnerPool } from './runner-pool.js'
import { closeOpenTurn } from './session-journal.js'
import type { TurnCheckpoints } from './turn-checkpoints.js'

/** A message announced by `announce`, until `deliver` has handed it over or given up. */
export interface Delivery {
  /** The CLI has been given the message: from then on only the CLI can stop the turn. */
  handing: boolean
  /** Stop asked before the hand-over. The turn is already closed in the journal; `deliver` drops the message, and with `terminate` stops the CLI it may have started. */
  cancel: 'interrupt' | 'terminate' | null
}

/** Sends slower than this are logged with their phases. */
const SLOW_SEND_MS = 1_000

/** What a delivery needs from the session manager beyond the pool, checkpoints and queue. */
export interface MessageDeliveryHooks {
  /** Before snapshot of the turn; see `SessionManager.openCheckpoint`. */
  openCheckpoint(conversation: ConversationRow): Promise<void>
  setStatus(conversationId: string, status: ConversationStatus): void
  /** The conversation is idle again: pending moves, restarts and queued messages go now. */
  settleIdle(conversationId: string): Promise<void>
}

/** A sent message's way to the CLI: announced in the journal at once, handed over once the CLI is up, or dropped when a stop comes first. */
export class MessageDelivery {
  /** Conversations whose announced message has not reached the CLI yet; see `announce`. */
  readonly pending = new Map<string, Delivery>()

  constructor(
    private readonly log: EventLog,
    private readonly pool: RunnerPool,
    private readonly turnCheckpoints: TurnCheckpoints,
    private readonly queue: MessageQueue,
    private readonly hooks: MessageDeliveryHooks,
  ) {}

  /** Journals the user's message and opens the turn before any CLI work. Starting a CLI takes seconds on Windows, MCP servers included, and users saw nothing until then: the thread shows the message and the activity indicator at Enter, for every CLI alike. Runners therefore no longer echo in `send`. `isBusy` holds until the hand-over so a second message queues instead of racing the start. */
  announce(conversation: ConversationRow, text: string, attachments: OutgoingAttachment[], mentions: OutgoingMention[], skills: string[]): void {
    // Commands the CLI last published for this conversation: a leading `/name` among them is one.
    const published = this.log.latest(conversation.id, ['commands.updated'], 1)[0]?.event as { commands?: { name: string }[] } | undefined
    const commands = published?.commands?.map((command) => command.name) ?? []
    const { blocks } = describeOutgoingMessage(text, attachments, null, { mentions, skills, commands })
    this.log.append(conversation.id, { type: 'message.completed', messageId: randomUUID(), role: 'user', blocks, parentToolCallId: null })
    this.log.append(conversation.id, { type: 'turn.started' })
    this.pending.set(conversation.id, { handing: false, cancel: null })
    this.hooks.setStatus(conversation.id, 'running')
  }

  /** Hands an announced message to the CLI, starting it when necessary. Failures are journaled where the message already sits and the conversation returns to idle: nobody awaits an HTTP reply anymore. Returns whether the CLI took the message. */
  async deliver(
    conversation: ConversationRow,
    release: () => void,
    text: string,
    attachments: OutgoingAttachment[],
    resolved: OutgoingMention[],
    skills: string[],
  ): Promise<boolean> {
    const conversationId = conversation.id
    const delivery = this.pending.get(conversationId)
    const started = Date.now()
    try {
      // Cold starts and the before snapshot are independent, and both are slow on Windows:
      // overlap them rather than paying for one after the other.
      const [runner] = await Promise.all([this.pool.ensure(conversation), this.hooks.openCheckpoint(conversation)])
      if (delivery?.cancel) {
        await this.drop(conversationId, delivery.cancel)
        return false
      }
      // The CLI may have died or been stopped while the snapshot finished: handing it the message
      // would reopen a turn that no process closes.
      if (this.pool.runners.get(conversationId)?.runner !== runner) throw new Error('The CLI stopped before receiving the message.')
      if (delivery) delivery.handing = true
      const prepared = Date.now()
      await runner.send(text, attachments, resolved, skills)
      // Only slow hand-overs are worth a log line: the Desktop keeps stderr, and this is what
      // the user waits for after Enter.
      if (Date.now() - started > SLOW_SEND_MS) {
        console.warn(`[sessions] slow send ${conversationId}: ${prepared - started} ms to start and snapshot, ${Date.now() - prepared} ms to hand over`)
      }
      this.pool.touch(conversationId)
      return true
    } catch (err) {
      this.turnCheckpoints.forget(conversationId)
      // Stopped while its CLI was starting: the stop explains the failure and has closed the turn.
      if (delivery?.cancel) {
        await this.drop(conversationId, delivery.cancel)
        return false
      }
      // The failure may be the journal itself, or a conversation deleted while its CLI started:
      // journaling must not throw past the status reset below, or the thread stays busy.
      try {
        this.log.append(conversationId, {
          type: 'error',
          code: 'send_failed',
          message: `The message could not be handed to the CLI: ${err instanceof Error ? err.message : String(err)}`,
          recoverable: true,
        })
      } catch (journalErr) {
        console.error('sillage: send failure not journaled', journalErr)
      }
      // `announce` opened a turn no CLI will close: the recoverable error above does not end it in
      // the thread, which kept its activity indicator and Stop button forever.
      closeOpenTurn(this.log, conversationId, 'failed')
      this.pending.delete(conversationId)
      this.hooks.setStatus(conversationId, 'idle')
      return false
    } finally {
      this.pending.delete(conversationId)
      release()
    }
  }

  /**
   * Stop asked while a message was on its way and the CLI did not have it yet: a cold start takes
   * seconds on Windows, and the message used to reach the CLI anyway once it was up. Closes the turn
   * `announce` opened, now, so Stop takes effect at once; `deliver` then drops the message.
   */
  cancel(conversationId: string, kind: 'interrupt' | 'terminate'): boolean {
    const delivery = this.pending.get(conversationId)
    if (!delivery || delivery.handing) return false
    if (delivery.cancel) return true
    delivery.cancel = kind
    this.log.append(conversationId, { type: 'turn.completed', stopReason: 'interrupted', costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })
    return true
  }

  /** `deliver`'s side of a cancellation: the message is dropped, a terminated conversation loses its CLI, an interrupted one keeps it warm and sends what was queued meanwhile. */
  private async drop(conversationId: string, kind: 'interrupt' | 'terminate'): Promise<void> {
    this.pending.delete(conversationId)
    this.turnCheckpoints.close(conversationId)
    if (kind === 'terminate') {
      await this.pool.stop(conversationId)
      this.queue.expire(conversationId)
      return
    }
    await this.hooks.settleIdle(conversationId)
  }
}
