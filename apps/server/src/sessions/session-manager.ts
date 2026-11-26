import type { BrowserManager } from '../browser/manager.js'
import { detach } from '../detach.js'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { and, eq } from 'drizzle-orm'
import {
  conversations,
  permissionRequests,
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
  type SillageEvent,
} from '@sillage/protocol'
import type { AgentRegistry } from '../agents/registry.js'
import { describeOutgoingMessage } from '../agents/outgoing.js'
import { adoptSessionTitle } from '../conversations/title.js'
import { checkpointBeforeProjectMove } from '../conversations/project-transfer.js'
import type { SecretStore } from '../secrets/store.js'
import type { ClaudeAccountStore } from '../claude-accounts/store.js'
import type { CodexAccountHomes } from '../codex-accounts/homes.js'
import type { CodexAccountStore } from '../codex-accounts/store.js'
import type { GrokAccountHomes } from '../grok-accounts/homes.js'
import type { AntigravityAccountHomes } from '../antigravity-accounts/homes.js'
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
  SteerOptions,
} from '../agents/types.js'
import type { Config } from '../config.js'
import type { EventLog } from '../events/event-log.js'
import { readAppSettings } from '../settings/app-settings.js'
import { resolveConversationCwd, resolveMention } from '../workspace.js'
import { HttpError, notFound } from '../http/errors.js'
import type { TurnUsageRecorder } from '../consumption/recorder.js'
import { notifyIfAway, type ConversationNotifier } from './session-notifications.js'
import {
  clearActivity,
  closeDetachedWork,
  closeInterruptedTurn,
  closeOpenTurn,
  expireOpenPrompts,
  recoverInterrupted,
  statusSnapshot,
} from './session-journal.js'
import { SessionAccounts } from './session-accounts.js'
import { RunnerContextFactory, type RunnerLease } from './runner-context.js'
import { ClientMessageDedupe, MessageQueue } from './message-queue.js'
import { TurnCheckpoints, type RestoreResult } from './turn-checkpoints.js'
import { ProjectMoves } from './project-moves.js'

export type { ConversationNotifier } from './session-notifications.js'

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

/** Sends slower than this are logged with their phases. */
const SLOW_SEND_MS = 1_000

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

export class SessionManager {
  private readonly runners = new Map<string, ManagedRunner>()
  /** In-progress starts so concurrent sends wait instead of duplicate processes. */
  private readonly startingRunners = new Map<string, Promise<AgentRunner>>()
  private readonly updatingClis = new Set<AgentKind>()
  private readonly cliOperations = new Map<AgentKind, number>()
  private readonly clientMessages = new ClientMessageDedupe()
  private readonly queue: MessageQueue
  private readonly turnCheckpoints: TurnCheckpoints
  private readonly moves: ProjectMoves
  /** Conversations whose announced message has not reached the CLI yet; see `announce`. */
  private readonly pendingDeliveries = new Map<string, Delivery>()
  /** Set by `stopAll`: the daemon is going away, nothing new starts and stopped runners write nothing more. */
  private closing = false
  /** Set later because the WebSocket hub tracking viewers does not exist when managers are constructed. */
  private notifier: ConversationNotifier | null = null
  readonly statusBus = new EventEmitter()
  private readonly accounts: SessionAccounts
  private readonly contexts: RunnerContextFactory

  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
    private readonly config: Config,
    private readonly registry: AgentRegistry,
    secrets: SecretStore,
    claudeAccounts: ClaudeAccountStore,
    codexAccounts: { store: CodexAccountStore; homes: CodexAccountHomes },
    grokAccounts: { store: GrokAccountStore; homes: GrokAccountHomes },
    antigravityAccounts: { store: AntigravityAccountStore; homes: AntigravityAccountHomes },
    /** Absent in tests that do not look at consumption. */
    private readonly usage: TurnUsageRecorder | null = null,
  ) {
    this.statusBus.setMaxListeners(200)
    this.accounts = new SessionAccounts(log, claudeAccounts, codexAccounts, grokAccounts, antigravityAccounts)
    this.queue = new MessageQueue(log)
    this.turnCheckpoints = new TurnCheckpoints(db, log, (conversationId) => this.workingDirectory(conversationId))
    this.moves = new ProjectMoves(db, log, this.statusBus, {
      canMove: (conversationId) => {
        const phase = this.phase(conversationId)
        return (phase === 'idle' || phase === 'cold') && !this.hasDetachedWork(conversationId)
      },
      stopRunner: (conversationId, options) => this.stopRunner(conversationId, options),
      flushQueue: (conversationId) => this.flushQueue(conversationId),
      broadcastStatus: (conversationId, status, warm) => this.broadcastStatus(conversationId, status, warm),
    })
    this.contexts = new RunnerContextFactory(db, log, config, registry, secrets, this.accounts, usage, {
      closing: () => this.closing,
      liveLease: (conversationId) => this.runners.get(conversationId)?.lease,
      setStatus: (conversationId, status) => this.setStatus(conversationId, status),
      setActivity: (conversationId, patch) => this.setActivity(conversationId, patch),
      notify: (conversationId, event) => notifyIfAway(this.db, this.notifier, conversationId, event),
      markEdited: (conversationId, path) => this.turnCheckpoints.markEdited(conversationId, path),
      closeCheckpoint: (conversationId) => this.turnCheckpoints.close(conversationId),
      adoptSuggestedTitle: (conversationId) => this.adoptSuggestedTitle(conversationId),
      stopAntigravityAccount: (accountId, exceptId) => this.stopAntigravityAccount(accountId, exceptId),
    })
  }

  /** Agent browsers, wired after construction like other optional services; absent in tests. */
  setBrowsers(browsers: BrowserManager): void {
    this.contexts.browsers = browsers
  }

  /** At startup no conversations can legitimately run: runners died with the previous process. Leaving `running` would misrepresent state and block messages. */
  recoverInterrupted(): string[] {
    return recoverInterrupted(this.db, this.log)
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
    const update: StatusBroadcast = {
      conversationId,
      status,
      warm,
      background: warm ? this.backgroundCount(conversationId) : 0,
      loops: warm ? this.loopCount(conversationId) : 0,
      appliedConfig: warm ? this.appliedConfig(conversationId) : null,
      ...statusSnapshot(this.db, conversationId),
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
    detach(notifyIfAway(this.db, this.notifier, conversationId, event), 'notification of an absent user')
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
    if (runners.some(([id]) => !this.isQuiescent(id) || this.hasDetachedWork(id) || this.queue.has(id))) return null
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
    if (this.moves.isMoving(conversationId)) return 'moving'
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
    if (this.moves.isPending(conversationId)) {
      await this.moves.apply(conversationId)
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
    return this.moves.moveToProject(conversationId, userId, target)
  }

  /** Also swept by the daemon after recovery and when detached work finishes. */
  async applyPendingProjectMoves(): Promise<void> {
    await this.moves.applyPending()
  }

  /** Sends the first queued message only. `runner.send` returns to `running`, so the next waits for another `turn.completed`. Sending everything together would merge messages into one turn, defeating queues. */
  private async flushQueue(conversationId: string): Promise<void> {
    // Turns may restart between status announcements and flushing: leave messages
    // queued until the next idle transition.
    if (this.isBusy(conversationId)) return

    const next = this.queue.shift(conversationId)
    if (!next) return

    try {
      const prepared = this.prepareSend(conversationId, next.mentions)
      this.announce(prepared.conversation, next.text, next.attachments, prepared.resolved, next.skills)
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
    if (!this.queue.contains(conversationId, queueId)) return 'gone'

    const managed = this.runners.get(conversationId)
    if (!managed) return 'unavailable'

    const { entry, restore } = this.queue.take(conversationId, queueId)!

    const conversation = this.loadConversation(conversationId)
    const resolved = this.resolveMentions(this.resolveCwd(conversation), entry.mentions)

    let steered = false
    try {
      steered = await managed.runner.steer(entry.text, entry.attachments, resolved, entry.skills)
    } finally {
      if (!steered) restore()
    }
    if (!steered) return 'unavailable'

    this.log.append(conversationId, { type: 'message.dequeued', queueId, reason: 'steered' })
    this.touch(conversationId)
    return 'steered'
  }

  /** Removes queued messages before sending. */
  cancelQueued(conversationId: string, queueId: string): boolean {
    return this.queue.cancel(conversationId, queueId)
  }

  antigravityHome(userId: string, accountId: string | null): string | undefined {
    return this.accounts.antigravityHome(userId, accountId)
  }

  codexHome(userId: string, accountId: string | null): string | undefined {
    return this.accounts.codexHome(userId, accountId)
  }

  grokHome(userId: string, accountId: string | null): string | undefined {
    return this.accounts.grokHome(userId, accountId)
  }

  /** Catalog for the account the configuration names: plans differ in which models they list. */
  modelsFor(userId: string, config: AgentConfig) {
    return this.registry.adapter(config.agent).models(this.accounts.catalogCredential(userId, config))
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
      const context = this.contexts.build(conversation)
      const runner = this.registry.adapter(conversation.agent).createRunner(context)
      if (!runner.importHistory) throw new Error('This CLI does not support history import.')
      try { await runner.importHistory() } finally { await runner.stop() }
    } finally {
      release()
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
    // Spawning in a missing directory fails with ENOENT, which the Claude SDK reports as a broken binary.
    const cwd = this.resolveCwd(fresh)
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`The working directory ${cwd} does not exist: check the project's path.`)
    }
    const lease: RunnerLease = { conversationId }
    const context = this.contexts.build(fresh, lease)
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
      clearActivity(this.db, conversationId)
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

  /** Steers current turns instead of opening new ones. False for unsupported CLIs, stopped sessions or turns finishing before clicks. Callers explain rather than silently queue: these actions have different outcomes. */
  async steer(
    conversationId: string,
    clientMessageId: string,
    text: string,
    attachments: OutgoingAttachment[] = [],
    mentions: string[] = [],
    skills: string[] = [],
    options: SteerOptions = {},
  ): Promise<boolean> {
    // Network retries must not steer twice: the first already delivered.
    if (!this.clientMessages.claim(conversationId, clientMessageId)) return true

    // Rejected or failed steering delivered nothing: callers fall back to
    // ordinary sends using the same ID, which must not count as duplicates.
    let steered = false
    try {
      const managed = this.runners.get(conversationId)
      if (!managed) return false

      const conversation = this.loadConversation(conversationId)
      const resolved = this.resolveMentions(this.resolveCwd(conversation), mentions)

      steered = await managed.runner.steer(text, attachments, resolved, skills, options)
      if (steered) this.touch(conversationId)
      return steered
    } finally {
      if (!steered) this.clientMessages.release(conversationId, clientMessageId)
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
    if (this.moves.isPending(conversationId)) await this.moves.apply(conversationId)
    if (!this.clientMessages.claim(conversationId, clientMessageId)) return

    // During active turns, messages wait rather than enter CLIs
    // and mix into current-turn context.
    if (this.isBusy(conversationId) || this.moves.isPending(conversationId)) {
      this.queue.push(conversationId, { clientMessageId, text, attachments, mentions, skills })
      this.touch(conversationId)
      return
    }

    let prepared: ReturnType<SessionManager['prepareSend']>
    try {
      prepared = this.prepareSend(conversationId, mentions)
    } catch (err) {
      // Sends failed before reaching CLIs: release IDs so clients can retry
      // without deduplication swallowing their messages.
      this.clientMessages.release(conversationId, clientMessageId)
      throw err
    }
    this.announce(prepared.conversation, text, attachments, prepared.resolved, skills)
    // Detached: the reply is 'accepted' and the thread already shows the message. The CLI start
    // that follows is what took seconds on Windows.
    detach(this.deliver(prepared.conversation, prepared.release, text, attachments, prepared.resolved, skills).then((delivered) => {
      if (!delivered) this.clientMessages.release(conversationId, clientMessageId)
    }), 'message delivery')
  }

  /** Journals the user's message and opens the turn before any CLI work. Starting a CLI takes seconds on Windows, MCP servers included, and users saw nothing until then: the thread shows the message and the activity indicator at Enter, for every CLI alike. Runners therefore no longer echo in `send`. `isBusy` holds until the hand-over so a second message queues instead of racing the start. */
  private announce(conversation: ConversationRow, text: string, attachments: OutgoingAttachment[], mentions: OutgoingMention[], skills: string[]): void {
    // Commands the CLI last published for this conversation: a leading `/name` among them is one.
    const published = this.log.latest(conversation.id, ['commands.updated'], 1)[0]?.event as { commands?: { name: string }[] } | undefined
    const commands = published?.commands?.map((command) => command.name) ?? []
    const { blocks } = describeOutgoingMessage(text, attachments, null, { mentions, skills, commands })
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
      // The CLI may have died or been stopped while the snapshot finished: handing it the message
      // would reopen a turn that no process closes.
      if (this.runners.get(conversationId)?.runner !== runner) throw new Error('The CLI stopped before receiving the message.')
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
      this.turnCheckpoints.forget(conversationId)
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
      // `announce` opened a turn no CLI will close: the recoverable error above does not end it in
      // the thread, which kept its activity indicator and Stop button forever.
      closeOpenTurn(this.log, conversationId, 'failed')
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
    this.turnCheckpoints.close(conversationId)
    if (kind === 'terminate') {
      await this.stopRunner(conversationId)
      this.queue.expire(conversationId)
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

  /** Captures pre-turn workspace state when enabled; see `TurnCheckpoints.open`. A method of its own so tests can hold a delivery between the CLI start and the hand-over. */
  private async openCheckpoint(conversation: ConversationRow): Promise<void> {
    await this.turnCheckpoints.open(conversation)
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
  ): Promise<RestoreResult> {
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

    return this.turnCheckpoints.restore(cwd, conversationId, key, options)
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
    await this.turnCheckpoints.inherit(fromId, toId)
  }

  /** Removes deleted/archived conversation snapshots without blocking. */
  async dropCheckpoints(conversationId: string): Promise<void> {
    await this.turnCheckpoints.drop(conversationId)
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
      // No CLI to answer with a `turn.completed`: a turn left open in the journal (a CLI that died,
      // a failed hand-over) would keep Stop visible and apparently ineffective.
      closeOpenTurn(this.log, conversationId, 'interrupted')
      this.setStatus(conversationId, 'idle')
      return
    }
    try {
      await managed.runner.interrupt()
    } catch (err) {
      // A CLI that is already gone rejects the interrupt (Claude SDK: "Query closed before response
      // received"). Stop is still honoured: drop the runner and close the turn ourselves.
      console.warn(`[sessions] interrupt of ${conversationId} failed, stopping its runner`, err)
      await this.stopRunner(conversationId)
      closeOpenTurn(this.log, conversationId, 'interrupted')
      this.setStatus(conversationId, 'idle')
    }
  }

  /** Permanently stops unwatched conversations: turn, process, background work and loops. `interrupt` alone leaves CLI-hosted work alive indefinitely, unsuitable for overlong scheduled runs. */
  async terminate(conversationId: string): Promise<void> {
    // A CLI still starting has no turn to interrupt: stopping it is enough, and `deliver` will not hand it the message.
    const starting = this.cancelDelivery(conversationId, 'terminate')
    const managed = this.runners.get(conversationId)
    if (managed && starting) {
      expireOpenPrompts(this.log, conversationId)
      await this.stopRunner(conversationId)
    } else if (managed) {
      await managed.runner.interrupt().catch(() => undefined)
      expireOpenPrompts(this.log, conversationId)
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
    if (!keepQueue) this.queue.expire(conversationId)

    this.runners.delete(conversationId)
    this.usage?.forget(conversationId)
    clearActivity(this.db, conversationId)
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
    closeDetachedWork(this.log, conversationId, managed.loops > 0)

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
        closeInterruptedTurn(this.db, this.log, conversationId, 'The daemon stopped during this conversation. The agent was interrupted.')
        const delivery = this.pendingDeliveries.get(conversationId)
        // A CLI that comes up after this snapshot is stopped by `deliver` instead of receiving the message.
        if (delivery && !delivery.handing) delivery.cancel = 'terminate'
        const managed = this.runners.get(conversationId)
        if (managed) managed.status = 'interrupted'
        // Already expired from the journal: `stopRunner` would announce them a second time.
        this.queue.discard(conversationId)
      } catch (err) {
        console.error(`sillage: closing the turn of ${conversationId} failed`, err)
      }
    }
    await Promise.allSettled([...this.runners.keys()].map((id) => this.stopRunner(id)))
  }

  private assertOpen(): void {
    if (this.closing) throw new HttpError(503, 'server_stopping', 'Sillage is stopping: send again once it is back.')
  }

  activeCount(): number {
    return this.runners.size
  }
}
