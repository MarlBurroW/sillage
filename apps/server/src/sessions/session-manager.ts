import type { BrowserManager } from '../browser/manager.js'
import { detach } from '../detach.js'
import { EventEmitter } from 'node:events'
import { and, eq } from 'drizzle-orm'
import { conversations, permissionRequests, type ConversationRow, type Db } from '@sillage/db'
import type {
  AgentConfig,
  AgentKind,
  BackgroundTaskOutput,
  ConversationMetrics,
  ConversationStatus,
  SillageEvent,
} from '@sillage/protocol'
import type { AgentRegistry } from '../agents/registry.js'
import { adoptSessionTitle } from '../conversations/title.js'
import { checkpointBeforeProjectMove } from '../conversations/project-transfer.js'
import type { SecretStore } from '../secrets/store.js'
import type { ClaudeAccountStore } from '../claude-accounts/store.js'
import type { CodexAccountHomes } from '../codex-accounts/homes.js'
import type { CodexAccountStore } from '../codex-accounts/store.js'
import type { GrokAccountHomes } from '../grok-accounts/homes.js'
import type { AntigravityAccountHomes } from '../antigravity-accounts/homes.js'
import type { GrokAccountStore } from '../grok-accounts/store.js'
import type { CopilotAccountHomes } from '../copilot-accounts/homes.js'
import type { CopilotAccountStore } from '../copilot-accounts/store.js'
import type { AntigravityAccountStore } from '../antigravity-accounts/store.js'
import type {
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
import { resolveConversationCwd, resolveMention } from '../workspace.js'
import { HttpError, notFound } from '../http/errors.js'
import type { TurnUsageRecorder } from '../consumption/recorder.js'
import { notifyIfAway, type ConversationNotifier } from './session-notifications.js'
import { closeInterruptedTurn, closeOpenTurn, expireOpenPrompts, recoverInterrupted, statusSnapshot } from './session-journal.js'
import { SessionAccounts } from './session-accounts.js'
import { RunnerContextFactory } from './runner-context.js'
import { ClientMessageDedupe, MessageQueue } from './message-queue.js'
import { TurnCheckpoints, type RestoreResult } from './turn-checkpoints.js'
import { ProjectMoves } from './project-moves.js'
import { RunnerPool } from './runner-pool.js'
import { MessageDelivery } from './message-delivery.js'
import { LiveConfig } from './live-config.js'
import { CliGate } from './cli-gate.js'

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
  private readonly pool: RunnerPool
  private readonly cliGate: CliGate
  private readonly clientMessages = new ClientMessageDedupe()
  private readonly queue: MessageQueue
  private readonly turnCheckpoints: TurnCheckpoints
  private readonly moves: ProjectMoves
  private readonly delivery: MessageDelivery
  private readonly liveConfig: LiveConfig
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
    config: Config,
    private readonly registry: AgentRegistry,
    secrets: SecretStore,
    claudeAccounts: ClaudeAccountStore,
    codexAccounts: { store: CodexAccountStore; homes: CodexAccountHomes },
    grokAccounts: { store: GrokAccountStore; homes: GrokAccountHomes },
    antigravityAccounts: { store: AntigravityAccountStore; homes: AntigravityAccountHomes },
    copilotAccounts: { store: CopilotAccountStore; homes: CopilotAccountHomes },
    /** Absent in tests that do not look at consumption. */
    usage: TurnUsageRecorder | null = null,
  ) {
    this.statusBus.setMaxListeners(200)
    this.cliGate = new CliGate(registry)
    this.accounts = new SessionAccounts(log, claudeAccounts, codexAccounts, grokAccounts, antigravityAccounts, copilotAccounts)
    this.queue = new MessageQueue(log)
    this.pool = new RunnerPool(db, log, config, registry, usage, {
      isQuiescent: (conversationId) => this.isQuiescent(conversationId),
      assertOpen: () => this.assertOpen(),
      loadConversation: (conversationId) => this.loadConversation(conversationId),
      assertCliEnabled: (kind) => this.assertCliEnabled(kind),
      buildContext: (conversation, lease) => this.contexts.build(conversation, lease),
      expireQueue: (conversationId) => this.queue.expire(conversationId),
      broadcastStatus: (conversationId, status, warm) => this.broadcastStatus(conversationId, status, warm),
    })
    this.turnCheckpoints = new TurnCheckpoints(db, log, (conversationId) => this.workingDirectory(conversationId))
    this.delivery = new MessageDelivery(log, this.pool, this.turnCheckpoints, this.queue, {
      openCheckpoint: (conversation) => this.openCheckpoint(conversation),
      setStatus: (conversationId, status) => this.setStatus(conversationId, status),
      settleIdle: (conversationId) => this.settleIdle(conversationId),
    })
    this.liveConfig = new LiveConfig(db, log, this.pool, {
      loadConversation: (conversationId) => this.loadConversation(conversationId),
      isBusy: (conversationId) => this.isBusy(conversationId),
      setStatus: (conversationId, status) => this.setStatus(conversationId, status),
    })
    this.moves = new ProjectMoves(db, log, this.statusBus, {
      canMove: (conversationId) => {
        const phase = this.phase(conversationId)
        return (phase === 'idle' || phase === 'cold') && !this.hasDetachedWork(conversationId)
      },
      stopRunner: (conversationId, options) => this.pool.stop(conversationId, options),
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

  /** Live runners, owned by the pool. */
  private get runners() {
    return this.pool.runners
  }

  /** Starts in progress, owned by the pool. */
  private get startingRunners() {
    return this.pool.starting
  }

  /** Conversations whose announced message has not reached the CLI yet, owned by the delivery. */
  private get pendingDeliveries() {
    return this.delivery.pending
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
    if (status === 'error') detach(this.pool.stop(conversationId), 'stopping a failed runner')
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

  /** Rejects CLIs turned off with `[agents.<cli>] enabled = false`; see `CliGate.assertEnabled`. */
  assertCliEnabled(kind: AgentKind): void {
    this.cliGate.assertEnabled(kind)
  }

  /** Reserve the CLI synchronously before awaiting checkpoints/startup, when runner status can still be idle. */
  private useCli(kind: AgentKind): () => void {
    return this.cliGate.use(kind)
  }

  /** Wait for turns, questions, background tasks and queued work; idle sessions resume on the new binary. */
  async prepareCliUpdate(kind: AgentKind): Promise<(() => void) | null> {
    return this.cliGate.prepareUpdate(
      kind,
      () => {
        const runners = [...this.runners].filter(([, managed]) => managed.runner.appliedConfig.agent === kind)
        if (runners.some(([id]) => !this.isQuiescent(id) || this.hasDetachedWork(id) || this.queue.has(id))) return null
        return runners.map(([id]) => id)
      },
      (ids) => Promise.all(ids.map((id) => this.pool.stop(id, { keepQueue: true }))),
    )
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
    return this.pool.hasDetachedWork(conversationId)
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
      await this.liveConfig.restart(conversationId, reason)
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
      this.delivery.announce(prepared.conversation, next.text, next.attachments, prepared.resolved, next.skills)
      await this.delivery.deliver(prepared.conversation, prepared.release, next.text, next.attachments, prepared.resolved, next.skills)
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
    const queued = this.queue.peek(conversationId, queueId)
    if (!queued) return 'gone'

    const managed = this.runners.get(conversationId)
    if (!managed) return 'unavailable'

    // Resolve before taking the entry out: a throw here must leave the message in the queue, since
    // only the steer call below puts it back on failure.
    const conversation = this.loadConversation(conversationId)
    const resolved = this.resolveMentions(this.resolveCwd(conversation), queued.mentions)
    const { entry, restore } = this.queue.take(conversationId, queueId)!

    let steered = false
    try {
      steered = await managed.runner.steer(entry.text, entry.attachments, resolved, entry.skills)
    } finally {
      if (!steered) restore()
    }
    if (!steered) return 'unavailable'

    this.log.append(conversationId, { type: 'message.dequeued', queueId, reason: 'steered' })
    this.pool.touch(conversationId)
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
      await this.pool.stop(id)
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
      if (steered) this.pool.touch(conversationId)
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
      this.pool.touch(conversationId)
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
    this.delivery.announce(prepared.conversation, text, attachments, prepared.resolved, skills)
    // Detached: the reply is 'accepted' and the thread already shows the message. The CLI start
    // that follows is what took seconds on Windows.
    detach(this.delivery.deliver(prepared.conversation, prepared.release, text, attachments, prepared.resolved, skills).then((delivered) => {
      if (!delivered) this.clientMessages.release(conversationId, clientMessageId)
    }), 'message delivery')
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

  /**
   * Restores the workspace to its state before a turn, or with `undo` puts it back as it was just
   * before the turn's last restoration. Either way the current state is captured first: a
   * restoration rewrites the whole directory, including work made since by the user or another
   * session, and nothing else would keep it. Refused during an active turn, which would race the
   * agent's writes, and serialized with Git tab actions on the same repository. The agent still
   * remembers the turn; the adjacent fork actions also rewind the conversation's context.
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
      const runner = await this.pool.ensure(conversation)
      const compacted = await runner.compact()
      if (compacted) this.pool.touch(conversationId)
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
    if (this.delivery.cancel(conversationId, 'interrupt')) {
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
      await this.pool.stop(conversationId)
      closeOpenTurn(this.log, conversationId, 'interrupted')
      this.setStatus(conversationId, 'idle')
    }
  }

  /** Permanently stops unwatched conversations: turn, process, background work and loops. `interrupt` alone leaves CLI-hosted work alive indefinitely, unsuitable for overlong scheduled runs. */
  async terminate(conversationId: string): Promise<void> {
    // A CLI still starting has no turn to interrupt: stopping it is enough, and `deliver` will not hand it the message.
    const starting = this.delivery.cancel(conversationId, 'terminate')
    const managed = this.runners.get(conversationId)
    if (managed && starting) {
      expireOpenPrompts(this.log, conversationId)
      await this.pool.stop(conversationId)
    } else if (managed) {
      await managed.runner.interrupt().catch(() => undefined)
      expireOpenPrompts(this.log, conversationId)
      await this.pool.stop(conversationId)
    }
    // CLIs may die before announcing turn completion.
    const { status } = this.loadConversation(conversationId)
    if (status === 'running' || status === 'awaiting_input') this.setStatus(conversationId, 'interrupted')
  }

  resolvePermission(conversationId: string, requestId: string, decision: PermissionDecision): boolean {
    const managed = this.runners.get(conversationId)
    if (!managed) return false
    const resolved = managed.runner.resolvePermission(requestId, decision)
    if (resolved) this.pool.touch(conversationId)
    return resolved
  }

  async answerQuestion(conversationId: string, requestId: string, answer: QuestionAnswer): Promise<boolean> {
    const managed = this.runners.get(conversationId)
    if (!managed) return false
    const answered = await managed.runner.answerQuestion(requestId, answer)
    if (answered) this.pool.touch(conversationId)
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
    if (resolved) this.pool.touch(conversationId)
    return resolved
  }

  reviewPlan(conversationId: string, requestId: string, review: PlanReview): boolean {
    const managed = this.runners.get(conversationId)
    if (!managed) return false
    const reviewed = managed.runner.reviewPlan(requestId, review)
    if (reviewed) this.pool.touch(conversationId)
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

  /** Applies reread database configuration; see `LiveConfig.reload`. */
  async reloadConfig(conversationId: string): Promise<void> {
    await this.liveConfig.reload(conversationId)
  }

  /** Retries one failed MCP server in an open session; see `LiveConfig.reconnectMcpServer`. */
  async reconnectMcpServer(conversationId: string, name: string): Promise<boolean> {
    return this.liveConfig.reconnectMcpServer(conversationId, name)
  }

  /** Reloads skills in affected open sessions; see `LiveConfig.reloadSkillLibrary`. */
  reloadSkillLibrary(projectId: string | null): void {
    this.liveConfig.reloadSkillLibrary(projectId)
  }

  /** Reapplies configuration in open sessions using an edited or deleted registry server; see `LiveConfig.reloadMcpServer`. */
  reloadMcpServer(serverId: string, formerProjectId: string | null = null): void {
    this.liveConfig.reloadMcpServer(serverId, formerProjectId)
  }

  /** Stops running conversation runners and reports release. Transcript resynchronization needs this because warm context ignores external CLI turns, while resume loads complete files. Refuse active turns: although callers check before reading, turns may start meanwhile; interruption loses work and adds `[Request interrupted by user]` messages later reimported. Live activity takes precedence. */
  async releaseRunner(conversationId: string): Promise<boolean> {
    if (this.isBusy(conversationId) || this.phase(conversationId) === 'starting') return false

    await this.pool.stop(conversationId)
    return true
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
    await Promise.allSettled([...this.runners.keys()].map((id) => this.pool.stop(id)))
  }

  private assertOpen(): void {
    if (this.closing) throw new HttpError(503, 'server_stopping', 'Sillage is stopping: send again once it is back.')
  }

  activeCount(): number {
    return this.runners.size
  }
}
