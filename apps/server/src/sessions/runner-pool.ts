import { statSync } from 'node:fs'
import type { ConversationRow, Db } from '@sillage/db'
import { DETACHED_WORK_EVICTED_NOTICE, type AgentKind, type ConversationStatus } from '@sillage/protocol'
import type { AgentRegistry } from '../agents/registry.js'
import type { AgentRunner, RunnerContext } from '../agents/types.js'
import type { Config } from '../config.js'
import type { EventLog } from '../events/event-log.js'
import type { TurnUsageRecorder } from '../consumption/recorder.js'
import { detach } from '../detach.js'
import { HttpError } from '../http/errors.js'
import { readAppSettings } from '../settings/app-settings.js'
import { resolveConversationCwd } from '../workspace.js'
import type { RunnerLease } from './runner-context.js'
import { clearActivity, closeDetachedWork } from './session-journal.js'

export interface ManagedRunner {
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

/** What the pool needs from the session manager, which knows the conversation's phase and queue. */
export interface RunnerPoolHooks {
  /** Nothing would be lost by stopping this CLI now, apart from detached work. */
  isQuiescent(conversationId: string): boolean
  /** Throws once the daemon is stopping. */
  assertOpen(): void
  loadConversation(conversationId: string): ConversationRow
  assertCliEnabled(kind: AgentKind): void
  buildContext(conversation: ConversationRow, lease: RunnerLease): RunnerContext
  /** The runner stopped for good: its queued messages can no longer depart. */
  expireQueue(conversationId: string): void
  broadcastStatus(conversationId: string, status: ConversationStatus, warm: boolean): void
}

/** Live CLI runners: start (one per conversation, within the session limit), inactivity reaping and stop. */
export class RunnerPool {
  readonly runners = new Map<string, ManagedRunner>()
  /** In-progress starts so concurrent sends wait instead of duplicate processes. */
  readonly starting = new Map<string, Promise<AgentRunner>>()

  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
    private readonly config: Config,
    private readonly registry: AgentRegistry,
    /** Absent in tests that do not look at consumption. */
    private readonly usage: TurnUsageRecorder | null,
    private readonly hooks: RunnerPoolHooks,
  ) {}

  /** Work living in the CLI process beyond turns (dev servers, loops): stopping the process ends it. */
  hasDetachedWork(conversationId: string): boolean {
    const managed = this.runners.get(conversationId)
    return Boolean(managed && (managed.background > 0 || managed.loops > 0))
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
        .filter(([id]) => this.hooks.isQuiescent(id))
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

      // Every quiet CLI hosts detached work: the oldest one goes anyway, but its thread must say
      // why its background tasks stopped, or the cut looks like a silent crash.
      const evictedWork = this.hasDetachedWork(oldest[0])
      await this.stop(oldest[0])
      if (evictedWork) {
        this.log.append(oldest[0], {
          type: 'agent.notice',
          code: DETACHED_WORK_EVICTED_NOTICE,
          message: `The concurrent session limit (${limit}) was reached: Sillage stopped this CLI and its background tasks.`,
          level: 'warning',
          details: { limit },
        })
      }
    }
  }

  async ensure(conversation: ConversationRow): Promise<AgentRunner> {
    const existing = this.runners.get(conversation.id)
    if (existing) return existing.runner

    // Only one startup per conversation: `makeRoom` yields control, so concurrent sends
    // could launch duplicate CLIs,
    // one leaking forever.
    const inFlight = this.starting.get(conversation.id)
    if (inFlight) return inFlight

    const starting = this.start(conversation.id).finally(() => {
      this.starting.delete(conversation.id)
    })
    this.starting.set(conversation.id, starting)
    return starting
  }

  private async start(conversationId: string): Promise<AgentRunner> {
    // A CLI started now would outlive the `stopAll` snapshot, with nothing left to stop it.
    this.hooks.assertOpen()
    await this.makeRoom()

    // Reread from the database: previous runners may have set agentSessionId.
    const fresh = this.hooks.loadConversation(conversationId)
    // Last guard before spawning: queued deliveries outlive the check made when they were accepted.
    this.hooks.assertCliEnabled(fresh.agent)
    // Spawning in a missing directory fails with ENOENT, which the Claude SDK reports as a broken binary.
    const cwd = resolveConversationCwd(this.db, fresh)
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`The working directory ${cwd} does not exist: check the project's path.`)
    }
    const lease: RunnerLease = { conversationId }
    const context = this.hooks.buildContext(fresh, lease)
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

  touch(conversationId: string): void {
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

    if (!this.hooks.isQuiescent(conversationId) || this.hasDetachedWork(conversationId)) {
      this.armIdleTimer(conversationId, managed)
      return
    }

    detach(this.stop(conversationId), 'idle runner reaping')
  }

  /** `keepQueue` preserves queues for intentional restarts immediately followed by fresh runners. Other stops are final. */
  async stop(
    conversationId: string,
    { keepQueue = false }: { keepQueue?: boolean } = {},
  ): Promise<void> {
    const managed = this.runners.get(conversationId)
    if (!managed) return

    // Pending messages cannot depart after runner shutdown: leaving them queued
    // would silently lose them at the next message.
    if (!keepQueue) this.hooks.expireQueue(conversationId)

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
    this.hooks.broadcastStatus(conversationId, managed.status, false)
  }
}
