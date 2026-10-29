import { personalMemoryDir, readPersonalMemory } from '../memory/personal.js'
import { conversationPath } from '@sillage/protocol'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { processOrigins } from '../services/origins.js'
import { and, eq, gt, or, sql } from 'drizzle-orm'
import {
  conversationHandoffs,
  conversations,
  permissionRequests,
  projects,
  type ConversationRow,
  type Db,
} from '@sillage/db'
import {
  parseAgentConfig,
  type AgentConfig,
  type AgentKind,
  type ConversationMetrics,
  type ConversationStatus,
  type CliRequestKind,
  type SillageEvent,
} from '@sillage/protocol'
import type { OutgoingNotification } from '../notifications/dispatcher.js'
import type { AgentRegistry } from '../agents/registry.js'
import { resolveBinary } from '../agents/cli-binary.js'
import { describeOutgoingMessage } from '../agents/outgoing.js'
import { builtinMcpEnabled, builtinMcpServer } from '../agents/mcp-builtin.js'
import { sessionReferenceContext } from '../conversations/references.js'
import { publicUrlOf } from '../settings/app-settings.js'
import { projectOverview, sessionTitleReminder } from '../agents/overview.js'
import { adoptSessionTitle } from '../conversations/title.js'
import { instructionsAppendix, resolveInstructionsMode } from '../instructions/store.js'
import { ensureProjectMemory, memoryAppendixForCodex } from '../memory/store.js'
import { resolveMcpServers } from '../agents/mcp-registry.js'
import type { SecretStore } from '../secrets/store.js'
import type { ClaudeAccountStore } from '../claude-accounts/store.js'
import { claudeCredential } from '../agents/claude/credential.js'
import type { CodexAccountHomes } from '../codex-accounts/homes.js'
import type { CodexAccountStore } from '../codex-accounts/store.js'
import type { GrokAccountHomes } from '../grok-accounts/homes.js'
import { userAntigravityHome, type AntigravityAccountHomes } from '../antigravity-accounts/homes.js'
import { logoutAntigravity } from '../antigravity-accounts/login.js'
import type { GrokAccountStore } from '../grok-accounts/store.js'
import type { AntigravityAccountStore } from '../antigravity-accounts/store.js'
import type {
  AgentRunner,
  ElicitationAnswer,
  OutgoingAttachment,
  OutgoingMention,
  PermissionDecision,
  PlanReview,
  QuestionAnswer,
  RunnerContext,
} from '../agents/types.js'
import type { Config } from '../config.js'
import type { EventLog } from '../events/event-log.js'
import { conversationMetrics } from '../conversations/metrics.js'
import { readAppSettings } from '../settings/app-settings.js'
import { SkillLibraryLayout } from '../skill-library/layout.js'
import { resolveConversationCwd, resolveMention } from '../workspace.js'
import { HttpError, notFound } from '../http/errors.js'
import {
  CheckpointError,
  captureSnapshot,
  checkpointRef,
  copyCheckpoints,
  deleteCheckpoints,
  diffCheckpoint,
  restoreSnapshot,
} from '../checkpoints.js'
import { serialized } from '../git-workflow.js'
import { linkedWorktreePaths } from '../worktrees/linked.js'

/** Message written during a turn, waiting for its completion. */
interface QueuedMessage {
  queueId: string
  clientMessageId: string
  text: string
  attachments: OutgoingAttachment[]
  mentions: string[]
  skills: string[]
}

interface ManagedRunner {
  runner: AgentRunner
  lastActivity: number
  status: ConversationStatus
  idleTimer: NodeJS.Timeout | null
  /** Live background work from the latest `background.updated`, held in memory rather than databases because it belongs to CLI processes and dies with them. Reloaded conversations have none after restart. */
  background: number
  /** Armed loops from the latest `loops.updated`, memory-only like background work because they cannot outlive CLI processes. */
  loops: number
  /** Reason a runner needs restarting when settings cannot apply live during turns. Restart waits for turn completion; otherwise null. See `reloadConfig`. */
  pendingRestart: string | null
}

/** Send deduplication window (invariant I5). See sendMessage(). */
const DEDUPE_TTL_MS = 5 * 60 * 1000

/** Open checkpoint for the current turn: before snapshot captured, after snapshot awaiting completion. Retain tool-touched files to distinguish turn work from files introduced by pulls. */
interface ActiveCheckpoint {
  key: string
  cwd: string
  edited: Set<string>
  /** Resolves once the before snapshot exists, false when its capture failed. Turns may start while it runs. */
  capture: Promise<boolean>
}

/** How long a send waits for the before snapshot. Capture takes tens of milliseconds on Linux but seconds on Windows, where every git process is slow: beyond this, the turn starts and the capture finishes alongside. The agent's first write follows a model round trip, so the snapshot still precedes it in practice. */
const CHECKPOINT_WAIT_MS = 1_000

/** Sends slower than this are logged with their phases. */
const SLOW_SEND_MS = 1_000

/** Beyond this limit, completion events omit files because conversations cannot display that many. */
const CHECKPOINT_EVENT_FILES = 500

/** Notifiable events and their meanings. Explicit allowlist rather than implicit rules: notifying every event would make notifications unread. Retain only agent decision requests and turn completions users cannot infer remotely. */
const NOTIFIABLE: Partial<Record<SillageEvent['type'], string>> = {
  'permission.requested': 'Une autorisation est demandée',
  'question.requested': "L'agent te demande de choisir",
  'elicitation.requested': 'Un service demande une saisie',
  'plan.review_requested': 'Un plan attend ta validation',
  'turn.completed': "L'agent a terminé",
}

/** Bus `status` payload reused unchanged by same-named WebSocket messages: hubs merely rebroadcast. */
export interface StatusBroadcast {
  conversationId: string
  status: ConversationStatus
  warm: boolean
  background: number
  loops: number
  /** See protocol `status`: active configuration or `null` for cold sessions. */
  appliedConfig: AgentConfig | null
  lastNotableSeq: number
  metrics: ConversationMetrics
}

/** Notification-layer contract without depending on its implementation. */
/** Notification routing (`notifications/dispatcher.ts`) as viewed here. */
export interface ConversationNotifier {
  dispatch(userId: string, notification: OutgoingNotification): Promise<void>
}

/** One-line CLI wait description: tool and command or question. */
function requestDetail(event: SillageEvent): string | null {
  const clip = (text: string) => (text.length > 160 ? `${text.slice(0, 160)}…` : text)
  if (event.type === 'permission.requested') {
    const input = (event.input ?? {}) as Record<string, unknown>
    const subject = [input.command, input.file_path, input.path, input.url, input.pattern].find((value) => typeof value === 'string')
    return clip(subject ? `${event.toolName} : ${String(subject)}` : event.toolName)
  }
  if (event.type === 'question.requested') return event.questions[0] ? clip(event.questions[0].question) : null
  if (event.type === 'elicitation.requested') return clip(`${event.serverName} : ${event.message}`)
  return null
}

const REQUEST_KINDS: Partial<Record<SillageEvent['type'], CliRequestKind>> = {
  'permission.requested': 'permission',
  'question.requested': 'question',
  'elicitation.requested': 'elicitation',
  'plan.review_requested': 'plan',
}

export class SessionManager {
  private readonly runners = new Map<string, ManagedRunner>()
  /** In-progress starts so concurrent sends wait instead of duplicate processes. */
  private readonly startingRunners = new Map<string, Promise<AgentRunner>>()
  private readonly updatingClis = new Set<AgentKind>()
  private readonly cliOperations = new Map<AgentKind, number>()
  private readonly recentClientMessages = new Map<string, number>()
  /** Pending messages per conversation, memory-only: messages never reaching CLIs need not survive restarts, and journals already allow clean closure on recovery (see `expireQueuedMessages`). */
  private readonly queues = new Map<string, QueuedMessage[]>()
  private readonly checkpoints = new Map<string, ActiveCheckpoint>()
  /** Conversations whose announced message has not reached the CLI yet; see `announce`. */
  private readonly pendingDeliveries = new Set<string>()
  /** Set later because the WebSocket hub tracking viewers does not exist when managers are constructed. */
  private notifier: ConversationNotifier | null = null
  readonly statusBus = new EventEmitter()

  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
    private readonly config: Config,
    private readonly registry: AgentRegistry,
    private readonly secrets: SecretStore,
    private readonly claudeAccounts: ClaudeAccountStore,
    private readonly codexAccounts: { store: CodexAccountStore; homes: CodexAccountHomes },
    private readonly grokAccounts: { store: GrokAccountStore; homes: GrokAccountHomes },
    private readonly antigravityAccounts: { store: AntigravityAccountStore; homes: AntigravityAccountHomes },
  ) {
    this.statusBus.setMaxListeners(200)
  }

  /** At startup no conversations can legitimately run: runners died with the previous process. Leaving `running` would misrepresent state and block messages. */
  recoverInterrupted(): string[] {
    const stale = this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.status, 'running'))
      .all()

    const awaiting = this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.status, 'awaiting_input'))
      .all()

    // Read before writes: resets below erase information needed to identify
    // conversations with detached work.
    const detached = new Map(
      this.db
        .select({ id: conversations.id, loops: conversations.loopCount })
        .from(conversations)
        .where(or(gt(conversations.backgroundCount, 0), gt(conversations.loopCount, 0)))
        .all()
        .map((row) => [row.id, row.loops > 0]),
    )

    for (const row of [...stale, ...awaiting]) {
      this.log.append(row.id, {
        type: 'error',
        code: 'daemon_restarted',
        // Web clients translate codes; English messages serve journal readers without
        // catalogs, including MCP and search.
        message: 'The daemon restarted during this conversation. The agent was interrupted.',
        recoverable: true,
      })
      this.expireOpenPrompts(row.id)
      this.expireQueuedMessages(row.id)
      this.closeDetachedWork(row.id, detached.get(row.id) ?? false)
      detached.delete(row.id)
      this.log.append(row.id, { type: 'session.ended', reason: 'interrupted' })
      this.db
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
      this.closeDetachedWork(conversationId, hadLoops)
    }

    // Conversations may already be idle, but their forms lost the runner
    // that could deliver answers.
    for (const conversationId of this.log.openAsyncQuestionConversationIds()) {
      this.expireOpenPrompts(conversationId)
    }

    this.db
      .update(permissionRequests)
      .set({ status: 'expired', decidedAt: Date.now() })
      .where(eq(permissionRequests.status, 'pending'))
      .run()

    // Database counterpart to journal closure above: sidebars read rows,
    // pages read journals, and both must agree.
    this.db
      .update(conversations)
      .set({ backgroundCount: 0, loopCount: 0 })
      .where(or(gt(conversations.backgroundCount, 0), gt(conversations.loopCount, 0)))
      .run()

    return [...stale, ...awaiting].map((row) => row.id)
  }

  /** Closes unanswered requests in journals. Rendering folds know only journals; without these events, pre-shutdown questions and permissions would remain pending with buttons reaching nobody. */
  private expireOpenPrompts(conversationId: string): void {
    for (const { kind, requestId } of this.log.openPrompts(conversationId)) {
      if (kind === 'permission') {
        this.log.append(conversationId, {
          type: 'permission.resolved',
          requestId,
          decision: 'expired',
          scope: 'once',
          decidedBy: null,
        })
      } else if (kind === 'elicitation') {
        this.log.append(conversationId, {
          type: 'elicitation.resolved',
          requestId,
          status: 'expired',
          content: {},
          decidedBy: null,
        })
      } else if (kind === 'question') {
        this.log.append(conversationId, {
          type: 'question.resolved',
          requestId,
          status: 'expired',
          answers: {},
          decidedBy: null,
        })
      } else {
        this.log.append(conversationId, {
          type: 'plan.review_resolved',
          requestId,
          decision: 'expired',
          followUpMode: null,
          decidedBy: null,
        })
      }
    }
  }

  private loadConversation(conversationId: string): ConversationRow {
    const row = this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get()
    if (!row) throw notFound('conversation_not_found', 'Conversation not found.')
    return row
  }

  /** Conversation working directory including worktrees. */
  workingDirectory(conversationId: string): string {
    return this.resolveCwd(this.loadConversation(conversationId))
  }

  /** Working directory: worktree when present, otherwise project root. */
  private resolveCwd(conversation: ConversationRow): string {
    return resolveConversationCwd(this.db, conversation)
  }

  private setStatus(conversationId: string, status: ConversationStatus): void {
    const managed = this.runners.get(conversationId)
    if (managed) managed.status = status

    this.db.update(conversations).set({ status }).where(eq(conversations.id, conversationId)).run()
    this.broadcastStatus(conversationId, status, this.isWarm(conversationId))

    // Turn just finished: the only point when queued messages can leave without
    // mixing into previous-turn context, and promised restarts can happen
    // without interrupting work.
    if (status === 'idle') void this.settleIdle(conversationId)

    // Errored runners are irrecoverably dead: retaining them routes subsequent
    // messages to unusable processes. Stop to free capacity;
    // the next message resumes through a fresh session.
    if (status === 'error') void this.stopRunner(conversationId)
  }

  /** Broadcasts status. Pass `warm` explicitly: stopping runners announces cold sessions while the map still contains warm entries. */
  private broadcastStatus(
    conversationId: string,
    status: ConversationStatus,
    warm: boolean,
  ): void {
    // Reread `lastNotableSeq` and metrics on every broadcast: journals are written
    // before status changes so values are fresh, and transitions occur only a few
    // times per turn. No additional
    // in-memory counters are needed.
    const row = this.db
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

    const update: StatusBroadcast = {
      conversationId,
      status,
      warm,
      background: warm ? this.backgroundCount(conversationId) : 0,
      loops: warm ? this.loopCount(conversationId) : 0,
      appliedConfig: warm ? this.appliedConfig(conversationId) : null,
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
    this.statusBus.emit('status', update)
  }

  /** Records continuing detached work in three synchronized steps: memory read by status streams, conversation rows visible across processes and broadcasts notifying clients. Separating them risks divergence, already observed before database updates were added. Without in-memory runners, ignore events from vanished processes whose teardown resets already ran. */
  private setActivity(
    conversationId: string,
    patch: { background?: number; loops?: number },
  ): void {
    const managed = this.runners.get(conversationId)
    if (!managed) return

    if (patch.background !== undefined) managed.background = patch.background
    if (patch.loops !== undefined) managed.loops = patch.loops

    this.db
      .update(conversations)
      .set({ backgroundCount: managed.background, loopCount: managed.loops })
      .where(eq(conversations.id, conversationId))
      .run()

    this.broadcastStatus(conversationId, managed.status, true)
  }

  /** Clears detached work when runner processes leave. Background work and loops belong to CLI processes and no longer exist; otherwise nonzero row counts would make conversations appear active forever. */
  private clearActivity(conversationId: string): void {
    this.db
      .update(conversations)
      .set({ backgroundCount: 0, loopCount: 0 })
      .where(eq(conversations.id, conversationId))
      .run()
  }

  /** Journals detached-work closure when processes leave, complementing `clearActivity`. Row resets suffice for database-reading sidebars but journal-only pages need events (invariant I2); otherwise final CLI lists show dead dev servers as alive forever. Write now instead of waiting for asynchronous abort-driven `session.ended`, which daemon shutdown may preempt. Close each task explicitly rather than silently empty lists: shells may survive hard daemon-only kills outside cgroup termination, and history must say work ended with sessions rather than normally. */
  private closeDetachedWork(conversationId: string, hadLoops: boolean): void {
    const live = this.log.openBackgroundTasks(conversationId)
    for (const task of live) {
      this.log.append(conversationId, {
        type: 'task.completed',
        taskId: task.id,
        status: 'stopped',
        summary: "Arrêté avec la session : le process CLI qui le portait s'est terminé.",
        durationMs: null,
        ambient: false,
      })
    }
    if (live.length > 0) this.log.append(conversationId, { type: 'background.updated', tasks: [] })
    // Loops die with processes too; CLIs list them only on demand,
    // so nothing else clears their last known list.
    if (hadLoops) this.log.append(conversationId, { type: 'loops.updated', loops: [] })
  }

  /** Current number of background tasks for this conversation. */
  backgroundCount(conversationId: string): number {
    return this.runners.get(conversationId)?.background ?? 0
  }

  /** Current number of armed loops for this conversation. */
  loopCount(conversationId: string): number {
    return this.runners.get(conversationId)?.loops ?? 0
  }

  /** Configuration the CLI is actually running, null without a running CLI. May differ from stored settings between requests for changes unsupported live and turn-end restarts applying them. */
  appliedConfig(conversationId: string): AgentConfig | null {
    return this.runners.get(conversationId)?.runner.appliedConfig ?? null
  }

  /** Forks conversations at history points. `throughSeq` is the last retained event: native CLI state must resume at the same point, preventing display/memory disagreement (invariant I2). Returns native fork session IDs for new conversation rows. Callers create rows and copy journals. */
  async forkSession(conversationId: string, throughSeq: number): Promise<string> {
    const conversation = this.loadConversation(conversationId)
    const release = this.useCli(conversation.agent)
    try {
      if (!conversation.agentSessionId) {
        throw new HttpError(
          400,
          'no_agent_session',
          'This conversation never started a session: there is nothing to fork.',
        )
      }

      // Cut points are CLI-specific (transcript entries, rollback turns…):
      // adapters calculate them from journals and consume them themselves.
      const adapter = this.registry.adapter(conversation.agent)
      return await adapter.fork(
        { agentSessionId: conversation.agentSessionId, cwd: this.resolveCwd(conversation) },
        adapter.forkCut(this.log, conversationId, throughSeq),
      )
    } finally {
      release()
    }
  }

  setNotifier(notifier: ConversationNotifier): void {
    this.notifier = notifier
  }

  /** Notifies owners unless viewing conversations. Sockets are the only reliable presence signal: subscribed tabs already receive live events, so additional system pushes would announce content being read. Errors never propagate because notification failures must not interrupt agents (invariant I1). */
  private async notifyIfAway(conversationId: string, event: SillageEvent): Promise<void> {
    const notifier = this.notifier
    const title = NOTIFIABLE[event.type]
    if (!notifier || !title) return

    try {
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
      // Scheduled run completion needs no announcement: hourly tasks would notify
      // twenty-four times daily. Decision requests always pass,
      // because runs remain blocked until someone responds.
      if (conversation.scheduleId && event.type === 'turn.completed') return
      const request = REQUEST_KINDS[event.type]

      // Visible target conversation: nothing. Visible elsewhere: request toasts only,
      // no turn-end toast because sidebars show it. Absent: system notification.
      await notifier.dispatch(conversation.userId, {
        kind: request ? 'cliRequest' : 'turnCompleted',
        conversationId,
        push: {
          title,
          body: conversation.title,
          url: conversationPath({ projectId: conversation.projectId, id: conversationId }),
          // Keep one displayed notification per conversation: five copies of 'agent finished'
          // add nothing beyond the latest.
          tag: conversationId,
          kind: request ?? 'turnCompleted',
        },
        toast: request
          ? {
              kind: 'cliRequest',
              request,
              conversationId,
              projectId: conversation.projectId,
              conversationTitle: conversation.title,
              detail: requestDetail(event),
            }
          : undefined,
      })
    } catch (err) {
      // Lost notifications are not conversation failures, but swallowing them
      // silently would prevent diagnosis.
      process.stderr.write(
        `[push] notification non emise pour ${conversationId} : ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      )
    }
  }

  /** Reserve the CLI synchronously before awaiting checkpoints/startup, when runner status can still be idle. */
  private useCli(kind: AgentKind): () => void {
    if (this.updatingClis.has(kind)) {
      throw new HttpError(503, 'cli_updating', '{label} is being updated. Try again when installation finishes.',
        { label: this.registry.adapter(kind).label })
    }
    this.cliOperations.set(kind, (this.cliOperations.get(kind) ?? 0) + 1)
    return () => {
      const count = (this.cliOperations.get(kind) ?? 1) - 1
      if (count) this.cliOperations.set(kind, count)
      else this.cliOperations.delete(kind)
    }
  }

  /** Wait for turns, questions, background tasks and queued work; idle sessions resume on the new binary. */
  async prepareCliUpdate(kind: AgentKind): Promise<(() => void) | null> {
    if (this.updatingClis.has(kind) || this.cliOperations.has(kind)) return null
    const runners = [...this.runners].filter(([, managed]) => managed.runner.appliedConfig.agent === kind)
    if (runners.some(([id, managed]) => this.isBusy(id) || managed.background > 0 || managed.loops > 0 || this.queues.has(id))) return null
    this.updatingClis.add(kind)
    try {
      await Promise.all(runners.map(([id]) => this.stopRunner(id, { keepQueue: true })))
      return () => { this.updatingClis.delete(kind) }
    } catch (err) {
      this.updatingClis.delete(kind)
      throw err
    }
  }

  /** Whether a CLI process still runs for this conversation. */
  isWarm(conversationId: string): boolean {
    return this.runners.has(conversationId)
  }

  /** Conversations with running CLIs for new-socket snapshots. */
  warmConversationIds(): string[] {
    return [...this.runners.keys()]
  }

  /** Whether messages sent now would not reach CLIs immediately. */
  private isBusy(conversationId: string): boolean {
    if (this.pendingDeliveries.has(conversationId)) return true
    const status = this.runners.get(conversationId)?.status
    return status === 'running' || status === 'awaiting_input'
  }

  /** On returning idle, apply pending restarts before flushing queues. Restarts call `setStatus('idle')` and reenter here; clear flags beforehand so reentry goes directly to queues and pending messages reach reconfigured runners. */
  private async settleIdle(conversationId: string): Promise<void> {
    const managed = this.runners.get(conversationId)
    if (managed?.pendingRestart) {
      const reason = managed.pendingRestart
      managed.pendingRestart = null
      await this.restartForConfig(conversationId, reason)
      return
    }

    await this.flushQueue(conversationId)
  }

  /** Sends the first queued message only. `runner.send` returns to `running`, so the next waits for another `turn.completed`. Sending everything together would merge messages into one turn, defeating queues. */
  private async flushQueue(conversationId: string): Promise<void> {
    // Turns may restart between status announcements and flushing: leave messages
    // queued until the next idle transition.
    if (this.isBusy(conversationId)) return

    const queue = this.queues.get(conversationId)
    const next = queue?.shift()
    if (!queue || !next) return
    if (queue.length === 0) this.queues.delete(conversationId)

    this.log.append(conversationId, {
      type: 'message.dequeued',
      queueId: next.queueId,
      reason: 'sent',
    })

    try {
      const prepared = this.prepareSend(conversationId, next.mentions)
      this.announce(prepared.conversation, next.text, next.attachments)
      await this.deliver(prepared.conversation, prepared.release, next.text, next.attachments, prepared.resolved, next.skills)
    } catch (err) {
      this.log.append(conversationId, {
        type: 'error',
        code: 'queued_message_failed',
        message: `The queued message could not be sent: ${
          err instanceof Error ? err.message : String(err)
        }`,
        recoverable: true,
      })
    }
  }

  /** Removes queued messages for injection into current turns. Remove before asynchronous CLI calls to prevent `flushQueue` sending them again during round trips; restore their positions on rejection, preserving original turn-end waits. */
  async steerQueued(
    conversationId: string,
    queueId: string,
  ): Promise<'steered' | 'gone' | 'unavailable'> {
    const queue = this.queues.get(conversationId)
    const entry = queue?.find((item) => item.queueId === queueId)
    if (!queue || !entry) return 'gone'

    const managed = this.runners.get(conversationId)
    if (!managed) return 'unavailable'

    const index = queue.indexOf(entry)
    queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(conversationId)

    const conversation = this.loadConversation(conversationId)
    const resolved = this.resolveMentions(this.resolveCwd(conversation), entry.mentions)

    let steered = false
    try {
      steered = await managed.runner.steer(entry.text, entry.attachments, resolved, entry.skills)
    } finally {
      if (!steered) {
        const restored = this.queues.get(conversationId) ?? []
        restored.splice(index, 0, entry)
        this.queues.set(conversationId, restored)
      }
    }
    if (!steered) return 'unavailable'

    this.log.append(conversationId, { type: 'message.dequeued', queueId, reason: 'steered' })
    this.touch(conversationId)
    return 'steered'
  }

  /** Removes queued messages before sending. */
  cancelQueued(conversationId: string, queueId: string): boolean {
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

  /** Closes messages left queued at daemon shutdown. Memory queues are lost; without events, replay would show them pending forever for sends that cannot happen. */
  private expireQueuedMessages(conversationId: string): void {
    for (const queueId of this.log.openQueuedMessages(conversationId)) {
      this.log.append(conversationId, { type: 'message.dequeued', queueId, reason: 'expired' })
    }
  }

  /** Selected Claude account tokens placed in variables taking precedence over stored CLI authentication (probed 2.1.296). Nothing for CLI-default authentication or other agents. Missing/deleted/foreign shared-project account references do not block startup: fall back to CLI login and disclose it in history because a different subscription pays. */
  private accountEnv(conversation: ConversationRow, config: AgentConfig): Record<string, string> {
    if (config.agent === 'antigravity') {
      const home = this.antigravityHome(conversation.userId, config.account)
      return { ...(home ? { GEMINI_HOME: home } : {}), SILLAGE_ANTIGRAVITY_SESSION_ROOT: this.antigravityAccounts.homes.sessions(conversation.userId) }
    }
    if (config.agent === 'opencode' || !config.account) return {}
    const missing = (code: string, message: string) => {
      this.log.append(conversation.id, { type: 'error', code, message, recoverable: true })
      return {}
    }
    if (config.agent === 'claude') {
      const resolved = this.claudeAccounts.resolveToken(conversation.userId, config.account)
      if (!resolved) {
        return missing(
          'claude_account_missing',
          "Le compte Claude choisi pour cette conversation n'existe plus : la session repart sur la connexion du CLI.",
        )
      }
      // Both override stored CLI authentication; noninteractive API keys are accepted
      // without prompts (probed 2.1.296).
      return resolved.kind === 'apiKey'
        ? { ANTHROPIC_API_KEY: resolved.token }
        : { CLAUDE_CODE_OAUTH_TOKEN: resolved.token }
    }
    // Grok follows Codex: per-account `GROK_HOME` with account-specific authentication.
    // Never-connected accounts count as absent.
    if (config.agent === 'grok') {
      const account = this.grokAccounts.store.find(conversation.userId, config.account)
      if (!account || account.status !== 'ready') {
        return missing(
          'grok_account_missing',
          account
            ? "Le compte Grok choisi pour cette conversation n'est pas connecté : la session repart sur la connexion du CLI."
            : "Le compte Grok choisi pour cette conversation n'existe plus : la session repart sur la connexion du CLI.",
        )
      }
      return { GROK_HOME: this.grokAccounts.homes.ensure(account.id) }
    }
    // Codex account home, where only auth.json is account-specific. Accounts never
    // connected count as absent: without auth.json, app-servers reject turns.
    const account = this.codexAccounts.store.find(conversation.userId, config.account)
    if (!account || account.status !== 'ready') {
      return missing(
        'codex_account_missing',
        account
          ? "Le compte Codex choisi pour cette conversation n'est pas connecté : la session repart sur la connexion du CLI."
          : "Le compte Codex choisi pour cette conversation n'existe plus : la session repart sur la connexion du CLI.",
      )
    }
    return { CODEX_HOME: this.codexAccounts.homes.ensure(account.id) }
  }

  antigravityHome(userId: string, accountId: string | null): string | undefined {
    if (!accountId) return undefined
    const account = this.antigravityAccounts.store.find(userId, accountId)
    if (!account || account.status !== 'ready') throw notFound('agent_account_not_found', 'Unknown connected Google account.')
    return this.antigravityAccounts.homes.ensure(account.id)
  }

  codexHome(userId: string, accountId: string | null): string | undefined {
    if (!accountId) return undefined
    const account = this.codexAccounts.store.find(userId, accountId)
    if (!account || account.status !== 'ready') throw notFound('agent_account_not_found', 'Unknown connected Codex account.')
    return this.codexAccounts.homes.ensure(account.id)
  }

  grokHome(userId: string, accountId: string | null): string | undefined {
    if (!accountId) return undefined
    const account = this.grokAccounts.store.find(userId, accountId)
    if (!account || account.status !== 'ready') throw notFound('agent_account_not_found', 'Unknown connected Grok account.')
    return this.grokAccounts.homes.ensure(account.id)
  }

  /** Catalog for the account the configuration names: plans differ in which models they list. */
  modelsFor(userId: string, config: AgentConfig) {
    let credential: string | undefined
    if (config.agent === 'antigravity') credential = this.antigravityHome(userId, config.account)
    else if (config.agent === 'codex') credential = this.codexHome(userId, config.account)
    else if (config.agent === 'grok') credential = this.grokHome(userId, config.account)
    else if (config.agent === 'claude' && config.account) {
      const resolved = this.claudeAccounts.resolveToken(userId, config.account)
      if (!resolved) throw notFound('agent_account_not_found', 'Unknown Claude account.')
      credential = claudeCredential(resolved.kind, resolved.token)
    }
    return this.registry.adapter(config.agent).models(credential)
  }

  /** A disconnected account must not continue requests from another warm session. */
  async stopAntigravityAccount(accountId: string, exceptId?: string): Promise<void> {
    for (const [id, managed] of this.runners) {
      const config = managed.runner.appliedConfig
      if (id === exceptId || config.agent !== 'antigravity' || config.account !== accountId) continue
      await this.stopRunner(id)
      this.log.append(id, { type: 'session.ended', reason: 'interrupted' })
      this.setStatus(id, 'idle')
    }
  }

  /** Imports through the same event translator as live sessions, preserving tool metadata. */
  async importNativeHistory(conversation: ConversationRow): Promise<void> {
    const release = this.useCli(conversation.agent)
    try {
      const context = this.buildContext(conversation)
      const runner = this.registry.adapter(conversation.agent).createRunner(context)
      if (!runner.importHistory) throw new Error('This CLI does not support history import.')
      try { await runner.importHistory() } finally { await runner.stop() }
    } finally {
      release()
    }
  }

  private buildContext(conversation: ConversationRow): RunnerContext {
    const memoryDirOrNull = (agent: ConversationRow['agent'], dir: string | null, sillageMcp: boolean) =>
      agent !== 'claude' && dir ? memoryAppendixForCodex(dir, sillageMcp) : null
    const conversationId = conversation.id
    const adapter = this.registry.adapter(conversation.agent)
    const config = parseAgentConfig(conversation.config)
    const cwd = this.resolveCwd(conversation)
    // Reread on every call rather than fix here: modes may change between runner
    // starts and depend on directory contents for legacy projects.
    const instructions = () => {
      if (conversation.projectId === null) return null
      const project = this.db
        .select({ instructionsMode: projects.instructionsMode, workspacePath: projects.workspacePath, memoryMode: projects.memoryMode })
        .from(projects)
        .where(eq(projects.id, conversation.projectId))
        .get()
      return project ? { ...project, mode: resolveInstructionsMode(project) } : null
    }
    // Create and initially import prior Claude workspace memory:
    // without import, moving directories would erase learning. Null in native
    // mode: each CLI retains its own memory and Sillage injects nothing.
    const memoryDir = () => {
      if (conversation.projectId === null) return personalMemoryDir(this.config.paths.memory, conversation.userId)
      const project = instructions()
      if (project?.memoryMode === 'native') return null
      return ensureProjectMemory(this.config.paths.memory, conversation.projectId, project?.workspacePath ?? cwd)
    }

    return {
      conversationId,
      cwd,
      config,
      // Resolve once here rather than in each runner: Codex passes this to `spawn`,
      // which searches PATH but ignores Sillage's managed installation
      // prefix. Bare runner names would miss
      // interface-installed CLIs.
      binary: resolveBinary(adapter.binary, adapter.cli.managedDir) ?? adapter.binary,
      attachmentsRoot: this.config.paths.attachments,
      accountSignedOut: async () => {
        if (config.agent !== 'antigravity') return
        if (config.account) await this.stopAntigravityAccount(config.account, conversationId)
        const home = this.antigravityHome(conversation.userId, config.account) ?? userAntigravityHome()
        await logoutAntigravity(await adapter.cli.executable(), home)
        if (config.account) this.antigravityAccounts.store.setIdentity(config.account, { authMode: null, email: null, plan: null })
      },
      processEnv: {
        ...processOrigins(this.config.paths.data).environment(conversation.projectId, conversationId, conversation.projectId === null ? conversation.userId : undefined),
        // Tells Claude Code a local host scheduled it rather than a person opening it
        // (probed 2.1.291). Other CLIs ignore this.
        ...(conversation.scheduleId && conversation.agent === 'claude'
          ? { CLAUDE_CODE_HOST_SCHEDULED_RUN: '1' }
          : {}),
        ...this.accountEnv(conversation, config),
      },
      // Sillage's server goes last: order resolves duplicate tool names,
      // and user-declared servers must win
      // over platform-added servers.
      resolveMcpServers: (current) => {
        const resolved = resolveMcpServers(this.db, this.secrets, current.mcpServers)
        const builtin = builtinMcpServer({
          enabled: this.config.mcp.sillageServer,
          config: current,
          databasePath: this.config.paths.database,
          projectId: conversation.projectId,
          conversationId,
          memoryDir: memoryDir(),
          memoryRoot: this.config.paths.memory,
        })
        return builtin ? { ...resolved, servers: [...resolved.servers, builtin] } : resolved
      },

      sessionReferenceContext: (text, current) => sessionReferenceContext(
        this.db, conversation.projectId, text, publicUrlOf(this.db, this.config),
        builtinMcpEnabled(this.config.mcp.sillageServer, current), conversation.userId,
      ),

      // Follow MCP server switches except `strictMcp`, which excludes undeclared
      // servers and therefore concerns tools rather than
      // Sillage's descriptions of platform state.
      //
      // SILLAGE.md bypasses these switches: user instructions are not optional
      // platform additions.
      projectOverview: (current) => {
        const sillageMcp = builtinMcpEnabled(this.config.mcp.sillageServer, current)
        // Source-conversation handoff context uses the same channel as SILLAGE.md,
        // outside all switches: this is the conversation's history,
        // not platform additions. Reread at every start because CLIs lose it
        // on resume, like instructions.
        const handoff = this.db
          .select({ text: conversationHandoffs.text })
          .from(conversationHandoffs)
          .where(eq(conversationHandoffs.conversationId, conversationId))
          .get()
        const parts = [
          handoff?.text ?? null,
          conversation.projectId === null ? `This is a personal Sillage discussion with its own persistent working directory. Keep new work and files here unless the user chooses another location. No project owns this discussion: never borrow Sandbox or another unrelated project just because a tool requires one. Model discovery with list_models needs no project. When an idea becomes a project or needs delegated project sessions, use continue_in_project to create a dedicated project with a self-contained brief (goal, decisions, relevant files, uncertainties and next steps) and explicitly selected files. If the user wants the work to continue now, supply prompt to start that linked session; otherwise its brief remains visible while it waits. Reuse the returned session with message_session rather than creating another continuation. The original files remain here, including large media. You may inspect, steer, interrupt and resume this account's project sessions using read_session, steer_session, interrupt_session and message_session. Use existing projects only when the user targets them. Use native file tools elsewhere only as requested and permitted by the CLI. Cite sessions as session:<id>.` : null,
          conversation.projectId === null ? sessionTitleReminder(this.db, { projectId: null, conversationId, sillageMcp }) : null,
          instructionsAppendix(this.db, {
            projectId: conversation.projectId,
            mode: instructions()?.mode ?? 'repo',
            sillageMcp,
          }),
          // Claude loads its memory index itself; Codex and opencode have only
          // the information supplied explicitly. Nothing in native mode.
          conversation.projectId === null
            ? `${memoryAppendixForCodex(memoryDir()!, sillageMcp, 'personal', conversation.agent !== 'claude') ?? ''}\n\nRetain durable preferences and decisions automatically, keep notes concise, and mention meaningful memory updates to the user. Memory belongs to this account and is shared across personal discussions. Never copy it into projects automatically.`
            : memoryDirOrNull(conversation.agent, memoryDir(), sillageMcp),
          this.config.mcp.sillageServer && current.sillageMcp && conversation.projectId
            ? projectOverview(this.db, {
                projectId: conversation.projectId,
                conversationId,
                sillageMcp,
              })
            : null,
        ].filter((part) => part !== null)
        return parts.length > 0 ? parts.join('\n\n') : null
      },
      memoryDir,
      maskedInstructionRoots: () => {
        const current = instructions()
        return current?.mode === 'sillage' ? [current.workspacePath, cwd] : []
      },
      skillRoots: (current) =>
        this.config.skills.library && current.skillLibrary
          ? new SkillLibraryLayout(this.config.paths.skillLibrary).rootsFor(conversation.projectId)
          : [],
      workTrees: () => conversation.projectId ? linkedWorktreePaths(this.db, conversationId, conversation.projectId) : [],
      resumeSessionId: conversation.agentSessionId,

      emit: (event: SillageEvent, raw?: unknown) => {
        this.log.append(conversationId, event, raw, adapter.rawFormat)
        if (event.type === 'turn.completed' && conversation.projectId === null) {
          void readPersonalMemory(this.db, personalMemoryDir(this.config.paths.memory, conversation.userId), conversation.userId, conversationId).catch(err => console.warn('Personal memory refresh failed', err))
        }
        void this.notifyIfAway(conversationId, event)
        // Journals suffice for open conversations folding events; conversation lists and
        // other processes have only conversation rows to determine
        // that work continues elsewhere.
        if (event.type === 'background.updated') {
          this.setActivity(conversationId, { background: event.tasks.length })
        }
        if (event.type === 'loops.updated') {
          this.setActivity(conversationId, { loops: event.loops.length })
        }
        // CLIs reemit initialization on live model changes:
        // retain the latest value for reads after sessions cool.
        if (event.type === 'session.started') {
          this.db
            .update(conversations)
            .set({ model: event.model })
            .where(eq(conversations.id, conversationId))
            .run()
        }
        // Not every usage update includes context: without this guard, the first missing
        // value would erase the only known figure.
        if (event.type === 'usage.updated' && event.context) {
          this.db
            .update(conversations)
            .set({
              contextUsedTokens: event.context.usedTokens,
              contextMaxTokens: event.context.maxTokens,
            })
            .where(eq(conversations.id, conversationId))
            .run()
        }
        if (event.type === 'file.edited') {
          this.checkpoints.get(conversationId)?.edited.add(event.path)
        }
        // Turn completion and snapshot completion are separate milestones: start capture
        // here without awaiting; status becomes idle independently.
        if (event.type === 'turn.completed' || event.type === 'session.ended') {
          this.closeCheckpoint(conversationId)
        }
        if (event.type === 'turn.completed') {
          this.log.refreshTurnCount(conversationId)
          // CLIs summarize sessions only after turns finish,
          // the first moment useful titles exist.
          void this.adoptSuggestedTitle(conversationId)
          // SQL increments rather than memory additions: `conversation` was read at runner
          // creation, so reusing it would overwrite previous turns.
          this.db
            .update(conversations)
            .set({
              costUsd: sql`${conversations.costUsd} + ${event.costUsd}`,
              inputTokens: sql`${conversations.inputTokens} + ${event.inputTokens}`,
              outputTokens: sql`${conversations.outputTokens} + ${event.outputTokens}`,
            })
            .where(eq(conversations.id, conversationId))
            .run()
        }
      },

      setStatus: (status) => this.setStatus(conversationId, status),

      setAgentSessionId: (sessionId) => {
        this.db
          .update(conversations)
          .set({ agentSessionId: sessionId })
          .where(eq(conversations.id, conversationId))
          .run()
      },

      updateConfig: (config) => {
        this.db
          .update(conversations)
          .set({ config: JSON.stringify(config) })
          .where(eq(conversations.id, conversationId))
          .run()
      },

      openPermissionRequest: (toolName, input) => {
        const id = randomUUID()
        const current = this.db
          .select({ lastSeq: conversations.lastSeq })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .get()

        this.db
          .insert(permissionRequests)
          .values({
            id,
            conversationId,
            seq: (current?.lastSeq ?? 0) + 1,
            toolName,
            input: JSON.stringify(input),
            status: 'pending',
            decisionScope: null,
            decidedBy: null,
            createdAt: Date.now(),
            decidedAt: null,
          })
          .run()
        return id
      },

      closePermissionRequest: (requestId, decision) => {
        this.db
          .update(permissionRequests)
          .set({
            status: decision.decision === 'allowed' ? 'allowed' : 'denied',
            decisionScope: decision.scope,
            decidedBy: decision.decidedBy,
            decidedAt: Date.now(),
          })
          .where(eq(permissionRequests.id, requestId))
          .run()
      },
    }
  }

  /** Makes room at session limits by stopping the oldest idle runner, which resumes on the next message without user loss. Reject when all work rather than exceed machine memory budgets. */
  private async makeRoom(): Promise<void> {
    // Reread limits at every start: settings are editable through the interface,
    // whereas constructor-captured values would wait for restart.
    const limit = readAppSettings(this.db, this.config).maxConcurrentSessions

    // Loop rather than stop once: lowering limits through the interface can leave
    // more live runners than available capacity.
    while (this.runners.size >= limit) {
      const idle = [...this.runners.entries()]
        .filter(([, managed]) => managed.status === 'idle' || managed.status === 'interrupted')
        .sort((a, b) => a[1].lastActivity - b[1].lastActivity)

      const oldest = idle[0]
      if (!oldest) {
        throw new HttpError(
          503,
          'session_limit_reached',
          'All {limit} concurrent sessions are busy. Wait for a conversation to finish.',
          { limit },
        )
      }

      await this.stopRunner(oldest[0])
    }
  }

  private async ensureRunner(conversation: ConversationRow): Promise<AgentRunner> {
    const existing = this.runners.get(conversation.id)
    if (existing) return existing.runner

    // Only one startup per conversation: `makeRoom` yields control, so concurrent sends
    // could launch duplicate CLIs,
    // one leaking forever.
    const inFlight = this.startingRunners.get(conversation.id)
    if (inFlight) return inFlight

    const starting = this.startRunner(conversation.id).finally(() => {
      this.startingRunners.delete(conversation.id)
    })
    this.startingRunners.set(conversation.id, starting)
    return starting
  }

  private async startRunner(conversationId: string): Promise<AgentRunner> {
    await this.makeRoom()

    // Reread from the database: previous runners may have set agentSessionId.
    const fresh = this.loadConversation(conversationId)
    const context = this.buildContext(fresh)
    const runner = this.registry.adapter(fresh.agent).createRunner(context)

    this.runners.set(conversationId, {
      runner,
      lastActivity: Date.now(),
      status: 'idle',
      idleTimer: null,
      background: 0,
      loops: 0,
      pendingRestart: null,
    })

    try {
      await runner.start()
    } catch (err) {
      // Failed starts must not occupy live slots; otherwise later sends would retry
      // nonexistent processes.
      this.runners.delete(conversationId)
      this.clearActivity(conversationId)
      await runner.stop().catch(() => undefined)
      throw err
    }
    return runner
  }

  private touch(conversationId: string): void {
    const managed = this.runners.get(conversationId)
    if (!managed) return

    managed.lastActivity = Date.now()
    this.armIdleTimer(conversationId, managed)
  }

  private armIdleTimer(conversationId: string, managed: ManagedRunner): void {
    if (managed.idleTimer) clearTimeout(managed.idleTimer)
    managed.idleTimer = setTimeout(
      () => this.reapIfIdle(conversationId),
      this.config.limits.sessionIdleTimeoutMin * 60 * 1000,
    )
    // Idle runners alone must not keep processes alive.
    managed.idleTimer.unref()
  }

  /** Inactivity deadline. User actions alone advance timers, so long autonomous turns previously expired and were interrupted: rearm while busy. Pending requests are also busy, as `isBusy` consistently reports. Waiting CLI tool calls consume nothing, and reaping lost questions and killed sessions after timers partly consumed by prior agent work; human requests must wait as long as needed. Detached work also counts: background dev servers live within CLI processes and must not die thirty minutes after messages. Check separately from `isBusy`, whose queue/control meaning remains 'CLI has control'; conversations hosting dev servers are still available for messages. */
  private reapIfIdle(conversationId: string): void {
    const managed = this.runners.get(conversationId)
    if (!managed) return

    if (this.isBusy(conversationId) || managed.background > 0 || managed.loops > 0) {
      this.armIdleTimer(conversationId, managed)
      return
    }

    void this.stopRunner(conversationId)
  }

  /** Resolves client mentions to absolute paths within working directories. Reject escaping `../` rather than truncate so agents never receive files different from those named. */
  private resolveMentions(cwd: string, relativePaths: string[]): OutgoingMention[] {
    return relativePaths.map((relativePath) => resolveMention(cwd, relativePath))
  }

  /** Records client message IDs and reports whether new (invariant I5). Memory windows suffice because duplicates are network retries seconds apart, never other processes. */
  private claimClientMessage(conversationId: string, clientMessageId: string): boolean {
    const key = `${conversationId}:${clientMessageId}`
    const now = Date.now()
    for (const [seen, ts] of this.recentClientMessages) {
      if (now - ts > DEDUPE_TTL_MS) this.recentClientMessages.delete(seen)
    }
    if (this.recentClientMessages.has(key)) return false
    this.recentClientMessages.set(key, now)
    return true
  }

  /** Releases claimed but undelivered IDs when sends fail before reaching CLIs, so legitimate retries are not swallowed as duplicates. */
  private releaseClientMessage(conversationId: string, clientMessageId: string): void {
    this.recentClientMessages.delete(`${conversationId}:${clientMessageId}`)
  }

  /** Steers current turns instead of opening new ones. False for unsupported CLIs, stopped sessions or turns finishing before clicks. Callers explain rather than silently queue: these actions have different outcomes. */
  async steer(
    conversationId: string,
    clientMessageId: string,
    text: string,
    attachments: OutgoingAttachment[] = [],
    mentions: string[] = [],
    skills: string[] = [],
  ): Promise<boolean> {
    // Network retries must not steer twice: the first already delivered.
    if (!this.claimClientMessage(conversationId, clientMessageId)) return true

    // Rejected or failed steering delivered nothing: callers fall back to
    // ordinary sends using the same ID, which must not count as duplicates.
    let steered = false
    try {
      const managed = this.runners.get(conversationId)
      if (!managed) return false

      const conversation = this.loadConversation(conversationId)
      const resolved = this.resolveMentions(this.resolveCwd(conversation), mentions)

      steered = await managed.runner.steer(text, attachments, resolved, skills)
      if (steered) this.touch(conversationId)
      return steered
    } finally {
      if (!steered) this.releaseClientMessage(conversationId, clientMessageId)
    }
  }

  async sendMessage(
    conversationId: string,
    clientMessageId: string,
    text: string,
    attachments: OutgoingAttachment[] = [],
    mentions: string[] = [],
    skills: string[] = [],
  ): Promise<void> {
    if (!this.claimClientMessage(conversationId, clientMessageId)) return

    // During active turns, messages wait rather than enter CLIs
    // and mix into current-turn context.
    if (this.isBusy(conversationId)) {
      const queueId = randomUUID()
      const queue = this.queues.get(conversationId) ?? []
      queue.push({ queueId, clientMessageId, text, attachments, mentions, skills })
      this.queues.set(conversationId, queue)

      this.log.append(conversationId, {
        type: 'message.queued',
        queueId,
        text,
        attachmentCount: attachments.length,
      })
      this.touch(conversationId)
      return
    }

    let prepared: ReturnType<SessionManager['prepareSend']>
    try {
      prepared = this.prepareSend(conversationId, mentions)
    } catch (err) {
      // Sends failed before reaching CLIs: release IDs so clients can retry
      // without deduplication swallowing their messages.
      this.releaseClientMessage(conversationId, clientMessageId)
      throw err
    }
    this.announce(prepared.conversation, text, attachments)
    // Detached: the reply is 'accepted' and the thread already shows the message. The CLI start
    // that follows is what took seconds on Windows.
    void this.deliver(prepared.conversation, prepared.release, text, attachments, prepared.resolved, skills).then((delivered) => {
      if (!delivered) this.releaseClientMessage(conversationId, clientMessageId)
    })
  }

  /** Journals the user's message and opens the turn before any CLI work. Starting a CLI takes seconds on Windows, MCP servers included, and users saw nothing until then: the thread shows the message and the activity indicator at Enter, for every CLI alike. Runners therefore no longer echo in `send`. `isBusy` holds until the hand-over so a second message queues instead of racing the start. */
  private announce(conversation: ConversationRow, text: string, attachments: OutgoingAttachment[]): void {
    const { blocks } = describeOutgoingMessage(text, attachments)
    this.log.append(conversation.id, { type: 'message.completed', messageId: randomUUID(), role: 'user', blocks, parentToolCallId: null })
    this.log.append(conversation.id, { type: 'turn.started' })
    this.pendingDeliveries.add(conversation.id)
    this.setStatus(conversation.id, 'running')
  }

  /** Hands an announced message to the CLI, starting it when necessary. Failures are journaled where the message already sits and the conversation returns to idle: nobody awaits an HTTP reply anymore. Returns whether the CLI took the message. */
  private async deliver(
    conversation: ConversationRow,
    release: () => void,
    text: string,
    attachments: OutgoingAttachment[],
    resolved: OutgoingMention[],
    skills: string[],
  ): Promise<boolean> {
    const conversationId = conversation.id
    const started = Date.now()
    try {
      // Cold starts and the before snapshot are independent, and both are slow on Windows:
      // overlap them rather than paying for one after the other.
      const [runner] = await Promise.all([this.ensureRunner(conversation), this.openCheckpoint(conversation)])
      const prepared = Date.now()
      await runner.send(text, attachments, resolved, skills)
      // Only slow hand-overs are worth a log line: the Desktop keeps stderr, and this is what
      // the user waits for after Enter.
      if (Date.now() - started > SLOW_SEND_MS) {
        console.warn(`[sessions] slow send ${conversationId}: ${prepared - started} ms to start and snapshot, ${Date.now() - prepared} ms to hand over`)
      }
      this.touch(conversationId)
      return true
    } catch (err) {
      this.checkpoints.delete(conversationId)
      this.log.append(conversationId, {
        type: 'error',
        code: 'send_failed',
        message: `The message could not be handed to the CLI: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: true,
      })
      this.pendingDeliveries.delete(conversationId)
      this.setStatus(conversationId, 'idle')
      return false
    } finally {
      this.pendingDeliveries.delete(conversationId)
      release()
    }
  }

  /** Synchronous part of a send: the conversation, the CLI lock and the mentions. Invalid mentions must reject sends rather than leave launched sessions with lost messages. */
  private prepareSend(conversationId: string, mentions: string[]): { conversation: ConversationRow; release: () => void; resolved: OutgoingMention[] } {
    const conversation = this.loadConversation(conversationId)
    const release = this.useCli(conversation.agent)
    try {
      return { conversation, release, resolved: this.resolveMentions(this.resolveCwd(conversation), mentions) }
    } catch (err) {
      release()
      throw err
    }
  }

  /** Captures pre-turn workspace state when enabled. Failure never blocks delivery: snapshots are convenience; turns are the work. Outside git, do nothing silently. */
  private async openCheckpoint(conversation: ConversationRow): Promise<void> {
    if (conversation.projectId === null || this.checkpoints.has(conversation.id)) return
    const project = this.db
      .select({ turnCheckpoints: projects.turnCheckpoints })
      .from(projects)
      .where(eq(projects.id, conversation.projectId))
      .get()
    if (!project?.turnCheckpoints) return

    const cwd = this.resolveCwd(conversation)
    const key = randomUUID()
    const capture = captureSnapshot(cwd, checkpointRef(conversation.id, key, 'before')).then(
      () => true,
      (err: unknown) => {
        if (!(err instanceof CheckpointError && err.code === 'checkpoint_not_repository')) {
          console.warn(`[checkpoints] capture avant le tour impossible (${conversation.id}) :`, err)
        }
        return false
      },
    )
    const entry: ActiveCheckpoint = { key, cwd, edited: new Set(), capture }

    let timer: NodeJS.Timeout | undefined
    const settled = await Promise.race([
      capture,
      new Promise<null>((resolveWait) => {
        timer = setTimeout(() => resolveWait(null), CHECKPOINT_WAIT_MS)
      }),
    ])
    clearTimeout(timer)
    if (settled === false) return

    // Journal the opening now even when the capture is still running: the thread attaches each
    // checkpoint to the next user message, so the marker must precede it.
    this.checkpoints.set(conversation.id, entry)
    this.log.append(conversation.id, { type: 'checkpoint.started', key })
    if (settled === null) {
      void capture.then((ok) => {
        if (ok || this.checkpoints.get(conversation.id) !== entry) return
        this.checkpoints.delete(conversation.id)
        this.failCheckpoint(conversation.id, key, 'The workspace could not be captured before the turn.')
      })
    }
  }

  private failCheckpoint(conversationId: string, key: string, reason: string): void {
    this.log.append(conversationId, {
      type: 'checkpoint.completed',
      key,
      status: 'failed',
      reason,
      files: [],
      truncated: false,
      excluded: 0,
    })
  }

  /** Captures post-turn state and journals changes without blocking. Remove open checkpoints before capture because queued messages may start another turn needing its own checkpoint meanwhile. */
  private closeCheckpoint(conversationId: string): void {
    const active = this.checkpoints.get(conversationId)
    if (!active) return
    this.checkpoints.delete(conversationId)

    void (async () => {
      // A short turn can end before the before snapshot is in: without it there is nothing to diff.
      if (!(await active.capture)) {
        this.failCheckpoint(conversationId, active.key, 'The workspace could not be captured before the turn.')
        return
      }
      try {
        await captureSnapshot(active.cwd, checkpointRef(conversationId, active.key, 'after'))
        const diff = await diffCheckpoint(active.cwd, conversationId, active.key, [...active.edited])
        this.log.append(conversationId, {
          type: 'checkpoint.completed',
          key: active.key,
          status: 'ready',
          reason: null,
          files: diff.files.slice(0, CHECKPOINT_EVENT_FILES),
          truncated: diff.files.length > CHECKPOINT_EVENT_FILES,
          excluded: diff.excluded,
        })
      } catch (err) {
        this.failCheckpoint(conversationId, active.key, err instanceof Error ? err.message : String(err))
      }
    })().catch((err: unknown) => {
      // Conversations may disappear during capture, leaving no journal to write.
      console.warn(`[checkpoints] capture après le tour perdue (${conversationId}) :`, err)
    })
  }

  /** Restores pre-turn workspace state. Reject during active turns to avoid racing agent writes. Serialize with Git tab actions on the same repository. Agents still remember the turn; adjacent fork actions also rewind conversation context. */
  async restoreCheckpoint(
    conversationId: string,
    key: string,
  ): Promise<{ written: number; deleted: number; indexRestored: boolean }> {
    if (this.isBusy(conversationId)) {
      throw new HttpError(
        409,
        'conversation_busy',
        'A turn is in progress: wait for it to finish before restoring the workspace.',
      )
    }
    const cwd = this.workingDirectory(conversationId)
    const result = await serialized(cwd, () =>
      restoreSnapshot(cwd, checkpointRef(conversationId, key, 'before')),
    )
    this.log.append(conversationId, {
      type: 'checkpoint.restored',
      key,
      written: result.written,
      deleted: result.deleted,
    })
    return result
  }

  /** Gives forks source snapshots so copied journal markers resolve. */
  async inheritCheckpoints(fromId: string, toId: string): Promise<void> {
    try {
      await copyCheckpoints(this.workingDirectory(toId), fromId, toId)
    } catch (err) {
      console.warn(`[checkpoints] copie au fork impossible (${fromId} -> ${toId}) :`, err)
    }
  }

  /** Removes deleted/archived conversation snapshots without blocking. */
  async dropCheckpoints(conversationId: string): Promise<void> {
    this.checkpoints.delete(conversationId)
    try {
      await deleteCheckpoints(this.workingDirectory(conversationId), conversationId)
    } catch (err) {
      console.warn(`[checkpoints] nettoyage impossible (${conversationId}) :`, err)
    }
  }

  /** Compacts conversation context. Restart cold runners because compaction requires loaded sessions and the next message would resume them anyway. */
  async compact(conversationId: string): Promise<boolean> {
    if (this.isBusy(conversationId)) {
      throw new HttpError(
        409,
        'conversation_busy',
        'A turn is in progress: wait for it to finish before compacting.',
      )
    }

    const conversation = this.loadConversation(conversationId)
    const release = this.useCli(conversation.agent)
    try {
      const runner = await this.ensureRunner(conversation)
      const compacted = await runner.compact()
      if (compacted) this.touch(conversationId)
      return compacted
    } finally {
      release()
    }
  }

  /** Stops background conversation work. Unlike compaction, do not restart cold runners: background work dies with CLI processes, leaving nothing to stop. */
  async stopBackgroundTask(conversationId: string, taskId: string): Promise<boolean> {
    const managed = this.runners.get(conversationId)
    if (!managed) return false
    return managed.runner.stopBackgroundTask(taskId)
  }

  async interrupt(conversationId: string): Promise<void> {
    const managed = this.runners.get(conversationId)
    if (!managed) {
      this.setStatus(conversationId, 'idle')
      return
    }
    await managed.runner.interrupt()
  }

  /** Permanently stops unwatched conversations: turn, process, background work and loops. `interrupt` alone leaves CLI-hosted work alive indefinitely, unsuitable for overlong scheduled runs. */
  async terminate(conversationId: string): Promise<void> {
    const managed = this.runners.get(conversationId)
    if (managed) {
      await managed.runner.interrupt().catch(() => undefined)
      this.expireOpenPrompts(conversationId)
      await this.stopRunner(conversationId)
    }
    // CLIs may die before announcing turn completion.
    const { status } = this.loadConversation(conversationId)
    if (status === 'running' || status === 'awaiting_input') this.setStatus(conversationId, 'interrupted')
  }

  resolvePermission(conversationId: string, requestId: string, decision: PermissionDecision): boolean {
    const managed = this.runners.get(conversationId)
    if (!managed) return false
    const resolved = managed.runner.resolvePermission(requestId, decision)
    if (resolved) this.touch(conversationId)
    return resolved
  }

  async answerQuestion(conversationId: string, requestId: string, answer: QuestionAnswer): Promise<boolean> {
    const managed = this.runners.get(conversationId)
    if (!managed) return false
    const answered = await managed.runner.answerQuestion(requestId, answer)
    if (answered) this.touch(conversationId)
    return answered
  }

  resolveElicitation(
    conversationId: string,
    requestId: string,
    answer: ElicitationAnswer,
  ): boolean {
    const managed = this.runners.get(conversationId)
    if (!managed) return false
    const resolved = managed.runner.resolveElicitation(requestId, answer)
    if (resolved) this.touch(conversationId)
    return resolved
  }

  reviewPlan(conversationId: string, requestId: string, review: PlanReview): boolean {
    const managed = this.runners.get(conversationId)
    if (!managed) return false
    const reviewed = managed.runner.reviewPlan(requestId, review)
    if (reviewed) this.touch(conversationId)
    return reviewed
  }

  hasPendingPermission(conversationId: string, requestId: string): boolean {
    const row = this.db
      .select({ id: permissionRequests.id })
      .from(permissionRequests)
      .where(
        and(
          eq(permissionRequests.id, requestId),
          eq(permissionRequests.conversationId, conversationId),
          // Resolved requests are no longer pending: otherwise callers would incorrectly
          // reply 'expired' to already answered requests.
          eq(permissionRequests.status, 'pending'),
        ),
      )
      .get()
    return row !== undefined
  }

  /** Native summaries are a fallback; explicit human and agent titles take precedence. */
  private async adoptSuggestedTitle(conversationId: string): Promise<void> {
    const managed = this.runners.get(conversationId)
    if (!managed) return

    const conversation = this.db
      .select({ title: conversations.title, titleSetByUser: conversations.titleSetByUser, titleSetByAgent: conversations.titleSetByAgent })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get()
    if (!conversation || conversation.titleSetByUser || conversation.titleSetByAgent) return

    const title = await managed.runner.suggestedTitle()
    if (!title || title === conversation.title) return

    adoptSessionTitle(this.db, this.statusBus, conversationId, title, 'cli')
  }

  /** Applies reread database configuration. SDK live model, effort and permission updates preserve context; stop and resume only on CLI rejection. Known exception: Claude `bypassPermissions` changes require startup in both directions. Entering explicitly fails ('the session was not launched with --dangerously-skip-permissions'); leaving apparently succeeds but is ineffective, so runners reject explicitly. Delay restart until turn completion to avoid losing ongoing work for future settings. */
  async reloadConfig(conversationId: string): Promise<void> {
    const managed = this.runners.get(conversationId)
    if (!managed) return

    const conversation = this.loadConversation(conversationId)
    const config = parseAgentConfig(conversation.config)

    let applied = false
    let reason: string | null = null
    try {
      applied = await managed.runner.applyConfig(config)
      if (!applied) reason = 'the CLI cannot apply this change live'
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err)
    }
    if (applied) {
      // Returning settings to live-applicable values cancels promised restarts:
      // otherwise sessions would restart needlessly after turns.
      managed.pendingRestart = null
      return
    }

    if (this.isBusy(conversationId)) {
      managed.pendingRestart = reason
      this.log.append(conversationId, {
        type: 'error',
        code: 'config_restart_deferred',
        message: 'This setting requires restarting the session: it will take effect at the end of the turn.',
        recoverable: true,
      })
      return
    }

    await this.restartForConfig(conversationId, reason)
  }

  /** Reloads skills in affected open sessions: all for global scope (`null`), project sessions otherwise. Fire and forget without failure: writes already succeeded and unsuccessful reloads apply on next resume. */
  reloadSkillLibrary(projectId: string | null): void {
    for (const [conversationId, managed] of this.runners) {
      if (projectId !== null) {
        const row = this.db
          .select({ projectId: conversations.projectId })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .get()
        if (row?.projectId !== projectId) continue
      }
      managed.runner.reloadSkillLibrary().catch((err: unknown) => {
        process.stderr.write(
          `[skills ${conversationId}] rechargement impossible : ${err instanceof Error ? err.message : String(err)}\n`,
        )
      })
    }
  }

  /** Reapplies configuration in open sessions using an edited or deleted registry server. Runners compare resolved servers, so an unchanged ID list with a new URL or token still reconnects; restarts wait for turn ends like any setting change. Fire and forget: the write already succeeded. */
  reloadMcpServer(serverId: string): void {
    for (const conversationId of this.runners.keys()) {
      const row = this.db
        .select({ config: conversations.config })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .get()
      if (!row || !parseAgentConfig(row.config).mcpServers.includes(serverId)) continue
      this.reloadConfig(conversationId).catch((err: unknown) => {
        process.stderr.write(
          `[mcp ${conversationId}] reconfiguration failed: ${err instanceof Error ? err.message : String(err)}\n`,
        )
      })
    }
  }

  /** Stops runners to reload current configuration. Explain fallback in conversations because reloading context has real cost users should understand. */
  private async restartForConfig(conversationId: string, reason: string | null): Promise<void> {
    // Queues survive: the next send finds them, and `deliver` starts fresh runners
    // with current configuration. Expiring messages would lose them
    // for restarts that otherwise lose nothing.
    await this.stopRunner(conversationId, { keepQueue: true })
    this.log.append(conversationId, {
      type: 'error',
      code: 'config_applied_by_restart',
      message: `Settings applied by restarting the session (${reason ?? 'no reason given'}).`,
      recoverable: true,
    })
    this.setStatus(conversationId, 'idle')
  }

  /** Stops running conversation runners and reports release. Transcript resynchronization needs this because warm context ignores external CLI turns, while resume loads complete files. Refuse active turns: although callers check before reading, turns may start meanwhile; interruption loses work and adds `[Request interrupted by user]` messages later reimported. Live activity takes precedence. */
  async releaseRunner(conversationId: string): Promise<boolean> {
    if (this.isBusy(conversationId)) return false

    await this.stopRunner(conversationId)
    return true
  }

  /** `keepQueue` preserves queues for intentional restarts immediately followed by fresh runners. Other stops are final. */
  private async stopRunner(
    conversationId: string,
    { keepQueue = false }: { keepQueue?: boolean } = {},
  ): Promise<void> {
    const managed = this.runners.get(conversationId)
    if (!managed) return

    // Pending messages cannot depart after runner shutdown: leaving them queued
    // would silently lose them at the next message.
    if (!keepQueue) {
      for (const entry of this.queues.get(conversationId) ?? []) {
        this.log.append(conversationId, {
          type: 'message.dequeued',
          queueId: entry.queueId,
          reason: 'expired',
        })
      }
      this.queues.delete(conversationId)
    }

    this.runners.delete(conversationId)
    this.clearActivity(conversationId)
    if (managed.idleTimer) clearTimeout(managed.idleTimer)
    await managed.runner.stop()
    // After shutdown, CLIs can no longer overwrite our final list;
    // synchronous writes persist even when daemon shutdown
    // follows immediately.
    this.closeDetachedWork(conversationId, managed.loops > 0)

    // Runner expiry does not change status: broadcast cold state or interfaces
    // would keep showing nonexistent warm sessions.
    this.broadcastStatus(conversationId, managed.status, false)
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runners.keys()].map((id) => this.stopRunner(id)))
  }

  activeCount(): number {
    return this.runners.size
  }
}
