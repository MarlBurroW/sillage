import { detach } from '../detach.js'
import { personalMemoryDir, readPersonalMemory } from '../memory/personal.js'
import { conversationPath } from '@sillage/protocol'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { processOrigins } from '../services/origins.js'
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'
import {
  conversationHandoffs,
  conversationProjectMoves,
  conversations,
  permissionRequests,
  projects,
  type ConversationRow,
  type Db,
  mcpServers,
} from '@sillage/db'
import {
  parseAgentConfig,
  type AgentConfig,
  type AgentKind,
  type BackgroundTaskOutput,
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
import { checkpointBeforeProjectMove, commitProjectMove, pendingProjectMove, prepareProjectMove, requestProjectMove } from '../conversations/project-transfer.js'
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
  moveSnapshot,
  readSnapshot,
  restoreSnapshot,
} from '../checkpoints.js'
import { serialized } from '../git-workflow.js'
import { linkedWorktreePaths } from '../worktrees/linked.js'
import type { TurnUsageRecorder } from '../consumption/recorder.js'

/** Message written during a turn, waiting for its completion. */
interface QueuedMessage {
  queueId: string
  clientMessageId: string
  text: string
  attachments: OutgoingAttachment[]
  mentions: string[]
  skills: string[]
}

/**
 * Where a conversation stands. That state is spread over the runner map, the delivery and the
 * start in progress and the move lock; every decision (queue or send, evict, reap, move, update
 * the CLI, release) reads it through `phase` instead of testing its own subset of those maps, which
 * is how eviction once ignored deliveries and a stop during a cold start was lost.
 */
type ConversationPhase =
  /** No CLI process and nothing on the way. */
  | 'cold'
  /** A CLI is starting outside a send (compaction on a cold conversation). */
  | 'starting'
  /** A message is announced and on its way to the CLI, whose start it may be waiting for. */
  | 'delivering'
  /** The conversation is changing project; its runner is being stopped. */
  | 'moving'
  | 'running'
  | 'awaiting'
  /** A warm CLI with no turn: idle, interrupted, or failed and about to be stopped. */
  | 'idle'

/** A message announced by `announce`, until `deliver` has handed it over or given up. */
interface Delivery {
  /** The CLI has been given the message: from then on only the CLI can stop the turn. */
  handing: boolean
  /** Stop asked before the hand-over. The turn is already closed in the journal; `deliver` drops the message, and with `terminate` stops the CLI it may have started. */
  cancel: 'interrupt' | 'terminate' | null
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
  /** Identity of this runner's context: see `RunnerLease`. */
  lease: RunnerLease
}

/**
 * Ties a runner's context to that runner rather than to its conversation. A stopped runner keeps
 * unwinding for a moment (Claude's stream ends after `stop`, then journals `session.ended` and
 * sets `idle`); when a successor already serves the conversation, those late calls would close
 * its turn and mark it idle mid-work. Calls are dropped once another lease holds the
 * conversation. Without a successor they still land: they are what closes the stopped turn.
 */
interface RunnerLease {
  readonly conversationId: string
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
  'mcp_install.requested': "L'agent propose d'installer un serveur MCP",
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
  if (event.type === 'mcp_install.requested') return clip(event.name)
  return null
}

const REQUEST_KINDS: Partial<Record<SillageEvent['type'], CliRequestKind>> = {
  'permission.requested': 'permission',
  'question.requested': 'question',
  'elicitation.requested': 'elicitation',
  'plan.review_requested': 'plan',
  'mcp_install.requested': 'mcpInstall',
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
  private readonly pendingDeliveries = new Map<string, Delivery>()
  /** Set by `stopAll`: the daemon is going away, nothing new starts and stopped runners write nothing more. */
  private closing = false
  private readonly projectMoveLocks = new Set<string>()
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
    /** Absent in tests that do not look at consumption. */
    private readonly usage: TurnUsageRecorder | null = null,
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
    if (status === 'idle') detach(this.settleIdle(conversationId), 'queue flush after a turn')

    // Errored runners are irrecoverably dead: retaining them routes subsequent
    // messages to unusable processes. Stop to free capacity;
    // the next message resumes through a fresh session.
    if (status === 'error') detach(this.stopRunner(conversationId), 'stopping a failed runner')
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

  /** Same notification as runner events, for journal entries written elsewhere, such as an agent's MCP proposal posted by `AgentRequests`. */
  notifyRequest(conversationId: string, event: SillageEvent): void {
    void this.notifyIfAway(conversationId, event)
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

  /** Rejects CLIs turned off with `[agents.<cli>] enabled = false`. Called before anything is written or spawned: the interface hides them, but stale clients, the API and scheduled tasks can still name them. */
  assertCliEnabled(kind: AgentKind): void {
    this.registry.adapter(kind).cli.assertEnabled()
  }

  /** Reserve the CLI synchronously before awaiting checkpoints/startup, when runner status can still be idle. */
  private useCli(kind: AgentKind): () => void {
    this.assertCliEnabled(kind)
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
    if (runners.some(([id]) => !this.isQuiescent(id) || this.hasDetachedWork(id) || this.queues.has(id))) return null
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

  private phase(conversationId: string): ConversationPhase {
    if (this.projectMoveLocks.has(conversationId)) return 'moving'
    if (this.pendingDeliveries.has(conversationId)) return 'delivering'
    if (this.startingRunners.has(conversationId)) return 'starting'
    const managed = this.runners.get(conversationId)
    if (!managed) return 'cold'
    if (managed.status === 'running') return 'running'
    if (managed.status === 'awaiting_input') return 'awaiting'
    return 'idle'
  }

  /** Whether messages sent now would not reach CLIs immediately: the CLI, or a hand-over to it, has control. */
  private isBusy(conversationId: string): boolean {
    const phase = this.phase(conversationId)
    return phase === 'moving' || phase === 'delivering' || phase === 'running' || phase === 'awaiting'
  }

  /** Work living in the CLI process beyond turns (dev servers, loops): stopping the process ends it. */
  private hasDetachedWork(conversationId: string): boolean {
    const managed = this.runners.get(conversationId)
    return Boolean(managed && (managed.background > 0 || managed.loops > 0))
  }

  /** Nothing would be lost by stopping this CLI now, apart from detached work, which callers weigh. */
  private isQuiescent(conversationId: string): boolean {
    return this.phase(conversationId) === 'idle'
  }

  /** On returning idle, apply pending restarts before flushing queues. Restarts call `setStatus('idle')` and reenter here; clear flags beforehand so reentry goes directly to queues and pending messages reach reconfigured runners. */
  private async settleIdle(conversationId: string): Promise<void> {
    if (pendingProjectMove(this.db, conversationId)) {
      await this.applyProjectMove(conversationId)
      return
    }
    const managed = this.runners.get(conversationId)
    if (managed?.pendingRestart) {
      const reason = managed.pendingRestart
      managed.pendingRestart = null
      await this.restartForConfig(conversationId, reason)
      return
    }

    await this.flushQueue(conversationId)
  }

  /** Agents request their own move during a turn; acknowledge it before stopping their MCP process. */
  async moveToProject(conversationId: string, userId: string, target: string) {
    const result = await requestProjectMove(this.db, conversationId, userId, target)
    await this.applyProjectMove(conversationId)
    const stored = this.db.select().from(conversationProjectMoves).where(eq(conversationProjectMoves.id, result.move.id)).get()
    if (stored?.error) throw new HttpError(409, 'project_move_failed', stored.error)
    if (stored?.completedAt === null) this.log.append(conversationId, {
      type: 'agent.notice', id: result.move.id, code: 'project_move_pending', level: 'info',
      message: `Move to ${result.project.name} scheduled after the turn and background work finish.`,
      details: { project: result.project.name },
    })
    this.statusBus.emit('lists')
    return { projectId: result.project.id, projectName: result.project.name, pending: Boolean(pendingProjectMove(this.db, conversationId)) }
  }

  /** Also swept by the daemon after recovery and when detached work finishes. */
  async applyPendingProjectMoves(): Promise<void> {
    const pending = this.db.select({ conversationId: conversationProjectMoves.conversationId }).from(conversationProjectMoves)
      .where(isNull(conversationProjectMoves.completedAt)).all()
    await Promise.all(pending.map(move => this.applyProjectMove(move.conversationId)))
  }

  private async applyProjectMove(conversationId: string): Promise<void> {
    const phase = this.phase(conversationId)
    if ((phase !== 'idle' && phase !== 'cold') || this.hasDetachedWork(conversationId)) return
    const pending = pendingProjectMove(this.db, conversationId)
    if (!pending) return
    this.projectMoveLocks.add(conversationId)
    try {
      const prepared = prepareProjectMove(this.db, this.log, conversationId)
      if (!prepared) return
      if (!(await stat(prepared.project.workspacePath).catch(() => null))?.isDirectory()) throw new Error('The destination project directory is missing.')
      await this.stopRunner(conversationId, { keepQueue: true })
      // Recheck access after stopping: project visibility may have changed meanwhile.
      const current = prepareProjectMove(this.db, this.log, conversationId)
      if (!current) return
      commitProjectMove(this.db, current)
      this.statusBus.emit('workspace', { conversationId })
      // Revoke old viewers' subscriptions before publishing events in the destination project.
      this.statusBus.emit('lists')
      this.log.append(conversationId, {
        type: 'agent.notice', id: current.move.id, code: 'project_moved', level: 'info',
        message: `Session moved to ${current.project.name}. History is preserved; the next message uses the destination workspace and instructions.`,
        details: { project: current.project.name, previousDirectory: current.move.fromCwd, directory: current.project.workspacePath },
      })
      this.broadcastStatus(conversationId, 'idle', false)
    } catch (error) {
      this.db.update(conversationProjectMoves).set({ completedAt: Date.now(), error: String(error) }).where(eq(conversationProjectMoves.id, pending.id)).run()
      this.log.append(conversationId, { type: 'agent.notice', code: 'project_move_failed', level: 'warning', message: `The session could not be moved: ${error instanceof Error ? error.message : String(error)}`, details: String(error) })
    } finally {
      this.projectMoveLocks.delete(conversationId)
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

  /** Pending messages that can no longer depart: journaled as expired, rather than lost silently at the next message. */
  private expireQueue(conversationId: string): void {
    for (const entry of this.queues.get(conversationId) ?? []) {
      this.log.append(conversationId, { type: 'message.dequeued', queueId: entry.queueId, reason: 'expired' })
    }
    this.queues.delete(conversationId)
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

  private buildContext(conversation: ConversationRow, lease?: RunnerLease): RunnerContext {
    const memoryDirOrNull = (agent: ConversationRow['agent'], dir: string | null, sillageMcp: boolean) =>
      agent !== 'claude' && dir ? memoryAppendixForCodex(dir, sillageMcp, 'project', true, agent !== 'antigravity') : null
    const conversationId = conversation.id
    const adapter = this.registry.adapter(conversation.agent)
    const config = parseAgentConfig(conversation.config)
    const cwd = this.resolveCwd(conversation)
    // History imports run without a lease: nothing to be superseded by.
    const superseded = () => {
      if (!lease) return false
      // Shutdown has journaled each turn's end itself: a runner unwinding after `stop` must not
      // mark its conversation idle, which hid it from restart recovery and from schedules.
      if (this.closing) return true
      const live = this.runners.get(conversationId)
      return live !== undefined && live.lease !== lease
    }
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
      // Benchmark runs share nothing: a variant that read what the previous one wrote would
      // not be measured on the same prompt.
      if (conversation.benchmarkId) return null
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
        const resolved = resolveMcpServers(this.db, this.secrets, current.mcpServers, conversation.projectId)
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
        // A benchmark run gets the prompt and nothing else: platform descriptions and memory
        // would add context one variant might use and another ignore.
        if (conversation.benchmarkId) return handoff?.text ?? null
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
            ? `${memoryAppendixForCodex(memoryDir()!, sillageMcp, 'personal', conversation.agent !== 'claude', conversation.agent !== 'antigravity') ?? ''}\n\nRetain durable preferences and decisions automatically, keep notes concise, and mention meaningful memory updates to the user. Memory belongs to this account and is shared across personal discussions. Never copy it into projects automatically.`
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
        if (superseded()) return
        const entry = this.log.append(conversationId, event, raw, adapter.rawFormat)
        this.usage?.observe(conversationId, entry, raw)
        if (event.type === 'turn.completed' && conversation.projectId === null && !conversation.benchmarkId) {
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
        if (event.type === 'usage.consumed') {
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
        if (event.type === 'turn.completed') {
          this.log.refreshTurnCount(conversationId)
          // CLIs summarize sessions only after turns finish,
          // the first moment useful titles exist.
          detach(this.adoptSuggestedTitle(conversationId), 'title adoption')
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

      setStatus: (status) => {
        if (!superseded()) this.setStatus(conversationId, status)
      },

      setAgentSessionId: (sessionId) => {
        if (superseded()) return
        this.db
          .update(conversations)
          .set({ agentSessionId: sessionId })
          .where(eq(conversations.id, conversationId))
          .run()
      },

      updateConfig: (config) => {
        if (superseded()) return
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
      // A runner still starting, or about to receive a message, has an idle status: the phase
      // tells it apart, evicting it would cut a launch in progress. Runners hosting a dev server
      // or a loop go last, since stopping them ends that work too.
      const idle = [...this.runners.entries()]
        .filter(([id]) => this.isQuiescent(id))
        .sort((a, b) => Number(this.hasDetachedWork(a[0])) - Number(this.hasDetachedWork(b[0])) || a[1].lastActivity - b[1].lastActivity)

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
    // A CLI started now would outlive the `stopAll` snapshot, with nothing left to stop it.
    this.assertOpen()
    await this.makeRoom()

    // Reread from the database: previous runners may have set agentSessionId.
    const fresh = this.loadConversation(conversationId)
    // Last guard before spawning: queued deliveries outlive the check made when they were accepted.
    this.assertCliEnabled(fresh.agent)
    const lease: RunnerLease = { conversationId }
    const context = this.buildContext(fresh, lease)
    const runner = this.registry.adapter(fresh.agent).createRunner(context)

    this.runners.set(conversationId, {
      runner,
      lastActivity: Date.now(),
      status: 'idle',
      idleTimer: null,
      background: 0,
      loops: 0,
      pendingRestart: null,
      lease,
    })

    try {
      await runner.start()
    } catch (err) {
      // Failed starts must not occupy live slots; otherwise later sends would retry
      // nonexistent processes.
      if (this.runners.get(conversationId)?.lease === lease) this.runners.delete(conversationId)
      this.clearActivity(conversationId)
      await runner.stop().catch(() => undefined)
      throw err
    }
    // Stopped while it was starting (terminate, a deletion): its entry is gone, and a runner
    // nobody tracks would keep a CLI alive that no interrupt, reaper or shutdown can reach.
    if (this.runners.get(conversationId)?.lease !== lease) {
      await runner.stop().catch(() => undefined)
      throw new Error('The session was stopped while its CLI was starting.')
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

    if (!this.isQuiescent(conversationId) || this.hasDetachedWork(conversationId)) {
      this.armIdleTimer(conversationId, managed)
      return
    }

    detach(this.stopRunner(conversationId), 'idle runner reaping')
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
    this.assertOpen()
    if (pendingProjectMove(this.db, conversationId)) await this.applyProjectMove(conversationId)
    if (!this.claimClientMessage(conversationId, clientMessageId)) return

    // During active turns, messages wait rather than enter CLIs
    // and mix into current-turn context.
    if (this.isBusy(conversationId) || pendingProjectMove(this.db, conversationId)) {
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
    detach(this.deliver(prepared.conversation, prepared.release, text, attachments, prepared.resolved, skills).then((delivered) => {
      if (!delivered) this.releaseClientMessage(conversationId, clientMessageId)
    }), 'message delivery')
  }

  /** Journals the user's message and opens the turn before any CLI work. Starting a CLI takes seconds on Windows, MCP servers included, and users saw nothing until then: the thread shows the message and the activity indicator at Enter, for every CLI alike. Runners therefore no longer echo in `send`. `isBusy` holds until the hand-over so a second message queues instead of racing the start. */
  private announce(conversation: ConversationRow, text: string, attachments: OutgoingAttachment[]): void {
    const { blocks } = describeOutgoingMessage(text, attachments)
    this.log.append(conversation.id, { type: 'message.completed', messageId: randomUUID(), role: 'user', blocks, parentToolCallId: null })
    this.log.append(conversation.id, { type: 'turn.started' })
    this.pendingDeliveries.set(conversation.id, { handing: false, cancel: null })
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
    const delivery = this.pendingDeliveries.get(conversationId)
    const started = Date.now()
    try {
      // Cold starts and the before snapshot are independent, and both are slow on Windows:
      // overlap them rather than paying for one after the other.
      const [runner] = await Promise.all([this.ensureRunner(conversation), this.openCheckpoint(conversation)])
      if (delivery?.cancel) {
        await this.dropDelivery(conversationId, delivery.cancel)
        return false
      }
      if (delivery) delivery.handing = true
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
      // Stopped while its CLI was starting: the stop explains the failure and has closed the turn.
      if (delivery?.cancel) {
        await this.dropDelivery(conversationId, delivery.cancel)
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
      this.pendingDeliveries.delete(conversationId)
      this.setStatus(conversationId, 'idle')
      return false
    } finally {
      this.pendingDeliveries.delete(conversationId)
      release()
    }
  }

  /**
   * Stop asked while a message was on its way and the CLI did not have it yet: a cold start takes
   * seconds on Windows, and the message used to reach the CLI anyway once it was up. Closes the turn
   * `announce` opened, now, so Stop takes effect at once; `deliver` then drops the message.
   */
  private cancelDelivery(conversationId: string, kind: 'interrupt' | 'terminate'): boolean {
    const delivery = this.pendingDeliveries.get(conversationId)
    if (!delivery || delivery.handing) return false
    if (delivery.cancel) return true
    delivery.cancel = kind
    this.log.append(conversationId, { type: 'turn.completed', stopReason: 'interrupted', costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })
    return true
  }

  /** `deliver`'s side of a cancellation: the message is dropped, a terminated conversation loses its CLI, an interrupted one keeps it warm and sends what was queued meanwhile. */
  private async dropDelivery(conversationId: string, kind: 'interrupt' | 'terminate'): Promise<void> {
    this.pendingDeliveries.delete(conversationId)
    this.closeCheckpoint(conversationId)
    if (kind === 'terminate') {
      await this.stopRunner(conversationId)
      this.expireQueue(conversationId)
      return
    }
    await this.settleIdle(conversationId)
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
      detach(capture.then((ok) => {
        if (ok || this.checkpoints.get(conversation.id) !== entry) return
        this.checkpoints.delete(conversation.id)
        this.failCheckpoint(conversation.id, key, 'The workspace could not be captured before the turn.')
      }), 'late checkpoint capture')
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
  /**
   * Restores the workspace to its state before a turn, or with `undo` puts it back as it was just
   * before the turn's last restoration. Either way the current state is captured first: a
   * restoration rewrites the whole directory, including work made since by the user or another
   * session, and nothing else would keep it.
   */
  async restoreCheckpoint(
    conversationId: string,
    key: string,
    options: { undo?: boolean } = {},
  ): Promise<{ written: number; deleted: number; indexRestored: boolean; skipped: number }> {
    if (checkpointBeforeProjectMove(this.db, conversationId, key)) throw new HttpError(409, 'checkpoint_previous_project', 'This checkpoint belongs to the previous project and cannot be restored here.')
    if (this.isBusy(conversationId)) {
      throw new HttpError(
        409,
        'conversation_busy',
        'A turn is in progress: wait for it to finish before restoring the workspace.',
      )
    }
    const cwd = this.workingDirectory(conversationId)
    // Sessions sharing the directory (the project root, typically) would have their files
    // rewritten in the middle of a turn without knowing it.
    const sharing = [...new Set([...this.runners.keys(), ...this.pendingDeliveries.keys()])].find((id) =>
      id !== conversationId && this.isBusy(id) && this.workingDirectoryOrNull(id) === cwd,
    )
    if (sharing) {
      throw new HttpError(409, 'checkpoint_workspace_busy', 'Another session is working in this directory: wait for its turn to finish before restoring.')
    }

    const undoRef = checkpointRef(conversationId, key, 'undo')
    const result = await serialized(cwd, async () => {
      if (!options.undo) {
        await captureSnapshot(cwd, undoRef)
        return restoreSnapshot(cwd, checkpointRef(conversationId, key, 'before'))
      }
      if (!(await readSnapshot(cwd, undoRef))) {
        throw new CheckpointError('checkpoint_missing', 'There is no restoration of this turn to undo.')
      }
      // Undoing is a restoration too: keep what it replaces, then make that the next undo point.
      const swap = `${undoRef}-next`
      await captureSnapshot(cwd, swap)
      const restored = await restoreSnapshot(cwd, undoRef)
      await moveSnapshot(cwd, swap, undoRef)
      return restored
    })
    this.log.append(conversationId, {
      type: 'checkpoint.restored',
      key,
      written: result.written,
      deleted: result.deleted,
      skipped: result.skipped,
      undoable: !options.undo,
      undone: options.undo === true,
    })
    return result
  }

  /** `workingDirectory` for a conversation that may have been deleted meanwhile. */
  private workingDirectoryOrNull(conversationId: string): string | null {
    try {
      return this.workingDirectory(conversationId)
    } catch {
      return null
    }
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

  /** Reads a background shell's tail without waking anything: a cold runner has no task left. */
  async readBackgroundTaskOutput(conversationId: string, taskId: string): Promise<BackgroundTaskOutput | null> {
    const managed = this.runners.get(conversationId)
    if (!managed?.runner.readBackgroundTaskOutput) return null
    return managed.runner.readBackgroundTaskOutput(taskId)
  }

  async interrupt(conversationId: string): Promise<void> {
    if (this.cancelDelivery(conversationId, 'interrupt')) {
      // Idle now, though the queue waits for `deliver` to let go of the conversation.
      this.setStatus(conversationId, 'idle')
      return
    }
    const managed = this.runners.get(conversationId)
    if (!managed) {
      this.setStatus(conversationId, 'idle')
      return
    }
    await managed.runner.interrupt()
  }

  /** Permanently stops unwatched conversations: turn, process, background work and loops. `interrupt` alone leaves CLI-hosted work alive indefinitely, unsuitable for overlong scheduled runs. */
  async terminate(conversationId: string): Promise<void> {
    // A CLI still starting has no turn to interrupt: stopping it is enough, and `deliver` will not hand it the message.
    const starting = this.cancelDelivery(conversationId, 'terminate')
    const managed = this.runners.get(conversationId)
    if (managed && starting) {
      this.expireOpenPrompts(conversationId)
      await this.stopRunner(conversationId)
    } else if (managed) {
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

  /**
   * Retries one failed MCP server in an open session. Allowed mid-turn, unlike compaction: the
   * agent itself often starts the dependency and needs the tools before the turn ends. A cold
   * conversation has nothing to reconnect, its next start connects everything anew.
   */
  async reconnectMcpServer(conversationId: string, name: string): Promise<boolean> {
    const managed = this.runners.get(conversationId)
    if (!managed) {
      throw new HttpError(409, 'conversation_cold', 'The session is not running: its next message reconnects every server.')
    }
    try {
      return await managed.runner.reconnectMcpServer(name)
    } catch (err) {
      if (err instanceof HttpError) throw err
      // The CLI's own words (ECONNREFUSED, 401…) tell the user what to fix; a generic 500 would hide them.
      throw new HttpError(502, 'mcp_reconnect_failed', err instanceof Error ? err.message : String(err))
    }
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

  /** Reapplies configuration in open sessions using an edited or deleted registry server: those selecting it, and every open session of the project it is scoped to, since project servers apply without selection. Runners compare resolved servers, so an unchanged ID list with a new URL or token still reconnects; restarts wait for turn ends like any setting change. `formerProjectId` covers the sessions a deletion or a move takes the server from, which the row no longer names. Fire and forget: the write already succeeded. */
  reloadMcpServer(serverId: string, formerProjectId: string | null = null): void {
    const scopedProject = this.db.select({ projectId: mcpServers.projectId }).from(mcpServers).where(eq(mcpServers.id, serverId)).get()?.projectId ?? null
    for (const conversationId of this.runners.keys()) {
      const row = this.db
        .select({ config: conversations.config, projectId: conversations.projectId })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .get()
      if (!row) continue
      const concerned = parseAgentConfig(row.config).mcpServers.includes(serverId)
        || (row.projectId !== null && (row.projectId === scopedProject || row.projectId === formerProjectId))
      if (!concerned) continue
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
    if (this.isBusy(conversationId) || this.phase(conversationId) === 'starting') return false

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
    if (!keepQueue) this.expireQueue(conversationId)

    this.runners.delete(conversationId)
    this.usage?.forget(conversationId)
    this.clearActivity(conversationId)
    if (managed.idleTimer) clearTimeout(managed.idleTimer)
    try {
      await managed.runner.stop()
    } catch (err) {
      // The rest still has to run: background work closed in the journal, cold status announced.
      console.error(`sillage: stopping the runner of ${conversationId} failed`, err)
    }
    // After shutdown, CLIs can no longer overwrite our final list;
    // synchronous writes persist even when daemon shutdown
    // follows immediately.
    this.closeDetachedWork(conversationId, managed.loops > 0)

    // Runner expiry does not change status: broadcast cold state or interfaces
    // would keep showing nonexistent warm sessions. Unless a successor already serves the
    // conversation (a configuration restart, a project move): it owns the status now.
    if (this.runners.has(conversationId)) return
    this.broadcastStatus(conversationId, managed.status, false)
  }

  /**
   * Daemon shutdown. Each turn in progress is closed in the journal and marked interrupted here,
   * as restart recovery would, rather than left to a race: a runner unwinding after `stop` could
   * mark its conversation idle before the process exited, and the interrupted turn then escaped
   * recovery, schedules and benchmarks. One runner failing to stop does not keep the others alive.
   */
  async stopAll(): Promise<void> {
    this.closing = true
    // A delivery waiting for its CLI has no runner in the map yet, but its turn is open all the same.
    for (const conversationId of new Set([...this.runners.keys(), ...this.pendingDeliveries.keys()])) {
      const phase = this.phase(conversationId)
      if (phase !== 'running' && phase !== 'awaiting' && phase !== 'delivering') continue
      try {
        this.closeInterruptedTurn(conversationId, 'The daemon stopped during this conversation. The agent was interrupted.')
        const delivery = this.pendingDeliveries.get(conversationId)
        // A CLI that comes up after this snapshot is stopped by `deliver` instead of receiving the message.
        if (delivery && !delivery.handing) delivery.cancel = 'terminate'
        const managed = this.runners.get(conversationId)
        if (managed) managed.status = 'interrupted'
        // Already expired from the journal: `stopRunner` would announce them a second time.
        this.queues.delete(conversationId)
      } catch (err) {
        console.error(`sillage: closing the turn of ${conversationId} failed`, err)
      }
    }
    await Promise.allSettled([...this.runners.keys()].map((id) => this.stopRunner(id)))
  }

  /** What a turn cut by the daemon leaves in the journal and the row, as `recoverInterrupted` writes it after a crash. */
  private closeInterruptedTurn(conversationId: string, message: string): void {
    this.log.append(conversationId, { type: 'error', code: 'daemon_restarted', message, recoverable: true })
    this.expireOpenPrompts(conversationId)
    this.expireQueuedMessages(conversationId)
    this.log.append(conversationId, { type: 'session.ended', reason: 'interrupted' })
    this.db.update(conversations).set({ status: 'interrupted' }).where(eq(conversations.id, conversationId)).run()
  }

  private assertOpen(): void {
    if (this.closing) throw new HttpError(503, 'server_stopping', 'Sillage is stopping: send again once it is back.')
  }

  activeCount(): number {
    return this.runners.size
  }
}
