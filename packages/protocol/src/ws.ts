import { z } from 'zod'
import { conversationStatusSchema, type ConversationMetrics } from './api.js'
import type { AgentConfig } from './agent-config.js'
import type { SillageEvent } from './events.js'
import type { InAppNotification } from './notifications.js'

/**
 * One WebSocket connection per tab, multiplexed across conversations: the sidebar follows
 * statuses while the main view follows a thread.
 */

/** Beyond this, the expanded explorer consumes more watchers than the machine allows. */
export const MAX_WATCHED_PATHS = 200

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('subscribe'),
    conversationId: z.string(),
    afterSeq: z.number().int().min(0),
    bodies: z.literal(1).optional(),
  }),
  z.object({ t: z.literal('unsubscribe'), conversationId: z.string() }),
  /**
   * Directories whose contents the client displays and therefore wants watched on disk. The
   * entire set is declared each time rather than added/removed incrementally: the client knows
   * expanded levels, and a lost delta could leave a directory watched forever or not at all.
   */
  z.object({
    t: z.literal('watch-tree'),
    /**
     * The explorer also works in project view without a conversation: watch the project
     * workspace rather than a thread's directory.
     */
    scope: z.enum(['conversation', 'project']),
    id: z.string(),
    // Bounded because each directory consumes an inotify watcher, a resource counted
    // per user on the host machine.
    paths: z.array(z.string()).max(MAX_WATCHED_PATHS),
  }),
  z.object({ t: z.literal('ping') }),
  /**
   * Is the tab visible, and which push subscription identifies its device? The server sends a
   * toast instead of a system notification to devices where the app is visible. A hidden tab
   * counts as absent.
   */
  z.object({
    t: z.literal('presence'),
    visible: z.boolean(),
    endpoint: z.string().max(2000).nullable(),
  }),
])
export type ClientMessage = z.infer<typeof clientMessageSchema>

export type ServerMessage =
  | {
      t: 'event'
      conversationId: string
      seq: number
      ts: number
      event: SillageEvent
    }
  | {
      t: 'status'
      conversationId: string
      status: z.infer<typeof conversationStatusSchema>
      /**
       * True if a CLI process is still alive for this conversation.
       *
       * Separate from status: an idle conversation may retain its loaded session or let it
       * expire. The next message then requires restarting the CLI and reloading context, useful
       * to know before wondering why the reply is slow.
       */
      warm: boolean
      /**
       * Active background job count for this conversation.
       *
       * Duplicates journal `background.updated` for the same reason as `warm`: the sidebar
       * follows unopened conversations without journals to fold. Process state, never
       * persisted: a cold conversation has no CLI and hence no background work.
       */
      background: number
      /**
       * Armed loop count for this conversation.
       *
       * Duplicates `loops.updated` for the same reason as `background`: the sidebar must
       * distinguish idle conversations from ones that will restart themselves without folding
       * their journals.
       */
      loops: number
      /**
       * Configuration actually used by the session; `null` when cold.
       *
       * Settings the CLI cannot change live remain at launch values until restart, while
       * requested values are already saved and displayed. This reveals when the current turn is
       * not yet using on-screen settings. Sent in full rather than limited to problematic
       * settings because those differ between CLIs; the client compares and reports only
       * differences. Cold sessions have nothing to compare: the next launch uses saved
       * configuration.
       */
      appliedConfig: AgentConfig | null
      /**
       * Latest `seq` worth notifying the reader about, for the same reason as the three
       * preceding fields.
       *
       * Carried by status rather than a dedicated stream: the sidebar cares about turn
       * completion, not every token. When a thread becomes idle it has finished producing
       * output; that is when the unread dot should appear. Following every event would make it
       * blink throughout the reply.
       *
       * Raw journal `seq` is unsuitable: it advances after everyone leaves when sessions cool
       * down or usage reports arrive.
       */
      lastNotableSeq: number
      /**
       * Volume metrics reread from the database on every broadcast.
       *
       * Carried by status for the same reason and cost as `lastNotableSeq`: the conversation
       * row is already read for it. They change at turn completion, when status changes anyway.
       */
      metrics: ConversationMetrics
    }
  /**
   * The CLI suggested a conversation title. Push rather than rediscover by refresh: titles
   * arrive after turn completion, so invalidation triggered by that same signal would race
   * them.
   */
  | { t: 'title'; conversationId: string; title: string }
  /** Toast for this visible tab: a decision or a CLI awaiting input elsewhere. */
  | { t: 'notify'; notification: InAppNotification }
  /** This account's decisions changed: the client rereads the list. */
  | { t: 'decisions-changed' }
  /**
   * A watched directory changed on disk: the client rereads that level.
   *
   * One path per message, since watches are already amortized server-side: batching would delay
   * quiet directories behind active ones.
   *
   * Catches changes missed by end-of-turn refresh: panel terminals, external editors, or
   * another conversation using the same worktree.
   */
  | { t: 'tree-changed'; scope: 'conversation' | 'project'; id: string; path: string }
  /**
   * Lag exceeds CATCHUP_THRESHOLD: the client must reload through paginated REST instead of
   * receiving socket deltas.
   */
  | { t: 'catchup'; conversationId: string; fromSeq: number; toSeq: number }
  /**
   * The project or conversation list changed: the client rereads it.
   *
   * The signal does not describe the change. Deletions, renames, archiving and reordering occur
   * only a few times per minute; rereading gives authoritative state without a delta for every
   * action.
   */
  | { t: 'lists-changed' }
  | { t: 'pong' }
  | { t: 'error'; code: string; message: string; params?: Record<string, string | number> }

export const CATCHUP_THRESHOLD = 500
export const HEARTBEAT_INTERVAL_MS = 25_000
