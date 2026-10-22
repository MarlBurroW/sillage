import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, notInArray } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import {
  agentRequests,
  automationDeliveries,
  conversations,
  projects,
  scheduledRuns,
  scheduledTasks,
  type AutomationDeliveryRow,
  type ScheduledRunRow,
  type ScheduledTaskRow,
} from '@sillage/db'
import { nextScheduleRun, parseAgentConfig, type ScheduleRunTrigger } from '@sillage/protocol'
import type { AgentRegistry } from '../agents/registry.js'
import { createConversation } from '../conversations/create.js'
import type { EventLog } from '../events/event-log.js'
import type { AppContext } from '../http/context.js'
import { HttpError, conflict } from '../http/errors.js'
import type { SessionManager } from '../sessions/session-manager.js'
import { buildWebhookPrompt } from '../automations/prompt.js'
import { eventOf, setDeliveryOutcome } from '../automations/webhooks.js'
import { launchRefusal } from '../sessions/agent-requests.js'
import { checkStateDir, firstLine, runCheck } from './check.js'
import { readCadence } from './tasks.js'

/** Executes scheduled tasks by opening fresh project sessions with task prompts and monitoring completion or maximum duration. Sweep database state in `next_run_at` rather than arm per-task `Cron` instances like housekeeping `Scheduler`: route/MCP creation, edits and pauses apply on the next sweep without rearming, and runs missed during downtime remain visible after restart. */

const TICK_MS = 5000

/** Previous run summary copied into the next prompt. */
const SUMMARY_MAX_CHARS = 2000

export class TaskScheduler {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private logger: FastifyBaseLogger | null = null
  /** Tasks currently launching runs. CLI startup takes seconds, during which 'run now' must not create duplicates. */
  private readonly firing = new Set<string>()
  /** Wake requested during a sweep: run another immediately afterward. */
  private again = false

  constructor(
    private readonly ctx: AppContext,
    private readonly sessions: SessionManager,
    private readonly registry: AgentRegistry,
    private readonly log: EventLog,
  ) {}

  start(logger: FastifyBaseLogger): void {
    this.logger = logger
    // Restart-interrupted checks can never finish because their scripts died with
    // the previous process. Leaving them running would block tasks forever.
    this.ctx.db
      .update(scheduledRuns)
      .set({ status: 'failed', finishedAt: Date.now(), error: 'Interrompu par un redémarrage de Sillage pendant la vérification.' })
      .where(eq(scheduledRuns.status, 'checking'))
      .run()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      // Handle active runs first: completed runs release capacity for waiting work
      // within the same sweep.
      await this.settleRuns(now)
      await this.fireDue(now)
      await this.drainWebhooks()
    } catch (err) {
      this.logger?.error({ err }, 'balayage des tâches planifiées en échec')
    } finally {
      this.busy = false
    }
    if (this.again) {
      this.again = false
      setImmediate(() => void this.tick())
    }
  }

  /** Immediate sweep so accepted webhooks need not wait five seconds. During a sweep, request another immediately afterward. */
  kick(): void {
    if (this.busy) {
      this.again = true
      return
    }
    void this.tick()
  }

  /** Whether sessions run, launch or already have queued calls. */
  isBusy(taskId: string): boolean {
    if (this.firing.has(taskId) || this.openRun(taskId)) return true
    return Boolean(this.ctx.db
      .select({ id: automationDeliveries.id })
      .from(automationDeliveries)
      .where(and(eq(automationDeliveries.taskId, taskId), eq(automationDeliveries.verdict, 'queued')))
      .get())
  }

  /** 'Run now' leaves the next scheduled run unchanged: a trial rather than a cadence change. Checks also run unless explicitly skipped, enabling full task testing including scripts. */
  async runNow(taskId: string, options: { skipCheck?: boolean } = {}): Promise<ScheduledRunRow> {
    const task = this.ctx.db.select().from(scheduledTasks).where(eq(scheduledTasks.id, taskId)).get()
    if (!task) throw new HttpError(404, 'schedule_not_found', 'Scheduled task not found.')
    if (readCadence(task.cadence).kind === 'webhook') {
      throw conflict('automation_needs_delivery', 'A webhook automation runs from a received call: replay one from its log.')
    }
    if (this.firing.has(task.id) || this.openRun(task.id)) {
      throw conflict('schedule_already_running', 'A run of this task is still in progress.')
    }
    const now = Date.now()
    if (task.checkScript && !options.skipCheck) return this.startChecked(task, 'manual', now, now)
    return this.fire(task, 'manual', now, now)
  }

  // --- Scheduled runs ------------------------------------------------------------

  private async fireDue(now: number): Promise<void> {
    const due = this.ctx.db
      .select({ task: scheduledTasks })
      .from(scheduledTasks)
      .innerJoin(projects, eq(projects.id, scheduledTasks.projectId))
      .where(
        and(
          eq(scheduledTasks.enabled, true),
          isNotNull(scheduledTasks.nextRunAt),
          lte(scheduledTasks.nextRunAt, now),
          // Archived projects do no work: tasks await their return.
          isNull(projects.archivedAt),
        ),
      )
      .all()

    for (const { task } of due) {
      if (this.firing.has(task.id)) continue
      const scheduledFor = task.nextRunAt ?? now

      if (this.openRun(task.id)) {
        // `wait` leaves tasks due until a sweep finds capacity.
        // One-shot tasks always wait; skipping would lose them.
        if (task.overlapPolicy === 'wait' || readCadence(task.cadence).kind === 'once') continue
        this.ctx.db
          .insert(scheduledRuns)
          .values({
            id: randomUUID(),
            taskId: task.id,
            conversationId: null,
            trigger: 'schedule',
            status: 'skipped',
            scheduledFor,
            startedAt: now,
            finishedAt: now,
            error: 'Le tir précédent tournait encore.',
            summary: null,
          })
          .run()
        this.advance(task, now)
        continue
      }

      if (task.checkScript) {
        // Do not await scripts, which may take minutes: sweeps also handle
        // other tasks and webhook calls.
        this.startChecked(task, 'schedule', scheduledFor, now)
        continue
      }
      await this.fire(task, 'schedule', scheduledFor, now)
    }
  }

  // --- Pre-turn checks -----------------------------------------------------------

  /** Starts runs for tasks with checks. Create `checking` rows immediately so history shows activity and duplicate runs cannot overlap. Script execution and session startup proceed without awaiting. */
  private startChecked(
    task: ScheduledTaskRow,
    trigger: 'schedule' | 'manual',
    scheduledFor: number,
    startedAt: number,
  ): ScheduledRunRow {
    this.firing.add(task.id)
    this.ctx.db.update(scheduledTasks).set({ lastRunAt: startedAt }).where(eq(scheduledTasks.id, task.id)).run()
    if (trigger === 'schedule') this.advance(task, startedAt)

    const run: ScheduledRunRow = {
      id: randomUUID(),
      taskId: task.id,
      conversationId: null,
      trigger,
      status: 'checking',
      scheduledFor,
      startedAt,
      finishedAt: null,
      error: null,
      summary: null,
      checkExitCode: null,
      checkOutput: null,
      checkStderr: null,
      checkDurationMs: null,
    }
    // Unreviewed agent scripts execute neither checks nor LLM turns:
    // tasks rely on checks for filtering, so bypassing them would ignore that contract.
    if (task.checkApprovedAt === null) {
      run.status = 'skipped'
      run.finishedAt = startedAt
      run.error = "Vérification proposée par un agent, en attente de validation : rien n'a été lancé."
      this.ctx.db.insert(scheduledRuns).values(run).run()
      this.firing.delete(task.id)
      return run
    }
    this.ctx.db.insert(scheduledRuns).values(run).run()
    void this.completeCheck(task, run)
    return run
  }

  private async completeCheck(task: ScheduledTaskRow, run: ScheduledRunRow): Promise<void> {
    const update = (patch: Partial<ScheduledRunRow>) =>
      this.ctx.db.update(scheduledRuns).set(patch).where(eq(scheduledRuns.id, run.id)).run()
    try {
      const project = this.ctx.db
        .select({ workspacePath: projects.workspacePath })
        .from(projects)
        .where(eq(projects.id, task.projectId))
        .get()
      if (!project) throw new Error('Le projet a disparu.')
      const previous = this.previousRun(task.id)
      const result = await runCheck(task.checkScript ?? '', {
        taskId: task.id,
        taskName: task.name,
        projectId: task.projectId,
        cwd: project.workspacePath,
        stateDir: checkStateDir(this.ctx.config.paths.data, task.id),
        firedAt: run.startedAt,
        trigger: run.trigger === 'manual' ? 'manual' : 'schedule',
        previous: previous && { startedAt: previous.startedAt, status: previous.status },
        timeoutMs: task.checkTimeoutSeconds * 1000,
      })
      const now = Date.now()
      update({
        checkExitCode: result.exitCode,
        checkOutput: result.stdout,
        checkStderr: result.stderr,
        checkDurationMs: result.durationMs,
      })

      if (result.verdict === 'skip') {
        update({ status: 'skipped', finishedAt: now, error: firstLine(result.stdout) ?? 'Rien à faire selon la vérification.' })
        return
      }
      if (result.verdict === 'error') {
        const detail = firstLine(result.stderr)
        update({
          status: 'failed',
          finishedAt: now,
          error: result.timedOut
            ? `Vérification interrompue au bout de ${task.checkTimeoutSeconds} s.`
            : `Vérification en échec (code ${result.exitCode ?? '?'})${detail ? ` : ${detail}` : ''}.`,
        })
        return
      }

      // Tasks may change or disappear during checks:
      // launch using their current configuration or not at all.
      const current = this.ctx.db.select().from(scheduledTasks).where(eq(scheduledTasks.id, task.id)).get()
      if (!current) return
      const conversationId = await this.openSession(current, run.trigger, run.startedAt, undefined, result.stdout)
      update({ status: 'running', conversationId })
    } catch (err) {
      update({
        status: 'failed',
        finishedAt: Date.now(),
        error: `Lancement impossible : ${err instanceof Error ? err.message : String(err)}`,
      })
      this.logger?.warn({ err, task: task.id }, 'tir planifié en échec à la vérification')
    } finally {
      this.firing.delete(task.id)
    }
  }

  // --- Pending webhook calls -----------------------------------------------

  /** Runs accepted calls oldest first, one per automation. Calls queued when paused must not launch later: reactivation should not replay three-day-old queues. */
  private async drainWebhooks(): Promise<void> {
    const queued = this.ctx.db
      .select({ delivery: automationDeliveries, task: scheduledTasks, archivedAt: projects.archivedAt })
      .from(automationDeliveries)
      .innerJoin(scheduledTasks, eq(scheduledTasks.id, automationDeliveries.taskId))
      .innerJoin(projects, eq(projects.id, scheduledTasks.projectId))
      .where(eq(automationDeliveries.verdict, 'queued'))
      .orderBy(asc(automationDeliveries.receivedAt))
      .all()

    const started = new Set<string>()
    for (const { delivery, task, archivedAt } of queued) {
      if (!task.enabled || archivedAt) {
        setDeliveryOutcome(this.ctx.db, delivery.id, {
          verdict: 'disabled',
          reason: { code: 'paused_in_queue' },
        })
        continue
      }
      if (started.has(task.id) || this.firing.has(task.id) || this.openRun(task.id)) continue
      // Chains may grow while waiting: recheck limits at launch.
      if (delivery.originConversationId) {
        const refusal = launchRefusal(this.ctx.db, delivery.originConversationId)
        if (refusal) {
          setDeliveryOutcome(this.ctx.db, delivery.id, { verdict: 'chain_refused', reason: refusal.reason })
          continue
        }
      }
      started.add(task.id)
      await this.fire(task, 'webhook', delivery.receivedAt, Date.now(), delivery)
    }
  }

  private openRun(taskId: string): ScheduledRunRow | undefined {
    return this.ctx.db
      .select()
      .from(scheduledRuns)
      .where(and(eq(scheduledRuns.taskId, taskId), inArray(scheduledRuns.status, ['running', 'checking'])))
      .get()
  }

  /** Arms the next run; completed one-shot tasks pause themselves. */
  private advance(task: ScheduledTaskRow, now: number): void {
    const cadence = readCadence(task.cadence)
    const nextRunAt = cadence.kind === 'once' ? null : nextScheduleRun(cadence, now, now)
    this.ctx.db
      .update(scheduledTasks)
      .set({ nextRunAt, enabled: nextRunAt !== null && task.enabled })
      .where(eq(scheduledTasks.id, task.id))
      .run()
  }

  private async fire(
    task: ScheduledTaskRow,
    trigger: ScheduleRunTrigger,
    scheduledFor: number,
    /** Sweep timestamp rather than a new clock read: schedule the next run from the same instant used to determine this run was due. */
    startedAt: number,
    /** Accepted call for webhook runs. */
    delivery?: AutomationDeliveryRow,
  ): Promise<ScheduledRunRow> {
    this.firing.add(task.id)
    const run: ScheduledRunRow = {
      id: randomUUID(),
      taskId: task.id,
      conversationId: null,
      trigger,
      status: 'running',
      scheduledFor,
      startedAt,
      finishedAt: null,
      error: null,
      summary: null,
      checkExitCode: null,
      checkOutput: null,
      checkStderr: null,
      checkDurationMs: null,
    }

    try {
      // Advance before launching: CLI startup failures must not leave tasks due
      // and retrying every five seconds.
      this.ctx.db.update(scheduledTasks).set({ lastRunAt: startedAt }).where(eq(scheduledTasks.id, task.id)).run()
      if (trigger === 'schedule') this.advance(task, startedAt)

      run.conversationId = await this.openSession(task, trigger, startedAt, delivery)
    } catch (err) {
      run.status = 'failed'
      run.finishedAt = Date.now()
      run.error = `Lancement impossible : ${err instanceof Error ? err.message : String(err)}`
      this.logger?.warn({ err, task: task.id }, 'tir planifié en échec au lancement')
    } finally {
      this.firing.delete(task.id)
    }

    this.ctx.db.insert(scheduledRuns).values(run).run()
    if (delivery) {
      setDeliveryOutcome(this.ctx.db, delivery.id, run.conversationId
        ? { verdict: 'launched', runId: run.id, conversationId: run.conversationId }
        : { verdict: 'launch_failed', reason: { code: 'launch_failed', params: { message: run.error ?? '' } }, runId: run.id })
    }
    return run
  }

  /** Open a run's session and return its ID. */
  private async openSession(
    task: ScheduledTaskRow,
    trigger: ScheduleRunTrigger,
    startedAt: number,
    delivery?: AutomationDeliveryRow,
    /** Check output when a check ran. */
    checkOutput?: string,
  ): Promise<string> {
    const config = await this.registry.adapter(task.agent).resolveDefaults(parseAgentConfig(task.config))
    const conversationId = randomUUID()
    const text = delivery
      ? buildWebhookPrompt({ task, delivery, event: eventOf(delivery), conversationId, replay: false })
      : buildRunPrompt({
          task,
          trigger,
          firedAt: startedAt,
          previous: this.previousRun(task.id),
          publicUrl: this.ctx.config.server.publicUrl,
          checkOutput,
        })
    const row = await createConversation(this.ctx.db, this.sessions, {
      id: conversationId,
      projectId: task.projectId,
      userId: task.userId,
      agent: task.agent,
      config,
      worktreeId: null,
      cardId: null,
      // Task name and time: under tasks, dates distinguish runs;
      // elsewhere (search, favorites), names identify them.
      title: `${task.name} · ${stamp(startedAt)}`,
      origin: null,
      scheduleId: task.id,
      firstMessage: {
        clientMessageId: randomUUID(),
        text,
        attachments: [],
        mentions: [],
        skills: [],
      },
    })
    if (delivery?.originConversationId) {
      // Ancestry read by chain limits: this session counts as launched
      // by the session whose marker appeared in the call.
      this.ctx.db.insert(agentRequests).values({
        id: randomUUID(),
        projectId: task.projectId,
        conversationId: delivery.originConversationId,
        kind: 'webhook_launch',
        payload: JSON.stringify({ taskId: task.id, deliveryId: delivery.id }),
        createdAt: startedAt,
        settledAt: startedAt,
        result: null,
        isError: false,
        launchedConversationId: row.id,
      }).run()
    }
    return row.id
  }

  /** Latest run actually opening a session, inherited by the next run. */
  private previousRun(taskId: string): ScheduledRunRow | null {
    return (
      this.ctx.db
        .select()
        .from(scheduledRuns)
        .where(
          and(
            eq(scheduledRuns.taskId, taskId),
            // Skipped or check-stopped runs leave nothing to pass on.
            isNotNull(scheduledRuns.conversationId),
            notInArray(scheduledRuns.status, ['running', 'checking']),
          ),
        )
        .orderBy(desc(scheduledRuns.startedAt))
        .limit(1)
        .get() ?? null
    )
  }

  // --- Active run monitoring -----------------------------------------------------

  /** Closes completed-session runs and stops overlong ones. Completion matches `notify_when_done`: no turn, background work or loop remains. Pending requests are not completion: humans may still answer, otherwise maximum duration eventually stops them. */
  private async settleRuns(now: number): Promise<void> {
    const open = this.ctx.db
      .select({ run: scheduledRuns, maxDurationMinutes: scheduledTasks.maxDurationMinutes })
      .from(scheduledRuns)
      .innerJoin(scheduledTasks, eq(scheduledTasks.id, scheduledRuns.taskId))
      .where(eq(scheduledRuns.status, 'running'))
      .all()

    for (const { run, maxDurationMinutes } of open) {
      const thread = run.conversationId
        ? this.ctx.db
            .select({
              status: conversations.status,
              background: conversations.backgroundCount,
              loops: conversations.loopCount,
            })
            .from(conversations)
            .where(eq(conversations.id, run.conversationId))
            .get()
        : undefined

      if (!run.conversationId || !thread) {
        this.close(run, 'failed', now, 'Le fil du tir a été supprimé avant sa fin.')
        continue
      }

      const working =
        thread.status === 'running' ||
        thread.status === 'awaiting_input' ||
        thread.background > 0 ||
        thread.loops > 0
      // Read the last journal event for idle conversations: between creation and the
      // CLI's first status they are idle without having done anything;
      // treating that as finished would close runs at birth.
      const dead = thread.status === 'interrupted' || thread.status === 'error'
      const [verdict] = working ? [] : this.log.latest(run.conversationId, ['turn.completed', 'error'], 1)

      if (working || (!verdict && !dead)) {
        if (now - run.startedAt < maxDurationMinutes * 60_000) continue
        const reason = `Durée maximale atteinte (${maxDurationMinutes} min) : le tir a été interrompu.`
        this.log.append(run.conversationId, {
          type: 'error',
          code: 'schedule_timeout',
          message: reason,
          recoverable: true,
        })
        await this.sessions.terminate(run.conversationId)
        this.close(run, 'timed_out', now, reason)
        continue
      }

      if (thread.status === 'interrupted') {
        this.close(run, 'failed', now, 'Tir interrompu avant sa fin (arrêt manuel ou redémarrage de Sillage).')
      } else if (thread.status === 'error' || verdict?.event.type === 'error') {
        const message = verdict?.event.type === 'error' ? verdict.event.message : 'Le CLI a terminé en erreur.'
        this.close(run, 'failed', now, message)
      } else {
        this.close(run, 'succeeded', now, null)
      }
    }
  }

  private close(
    run: ScheduledRunRow,
    status: 'succeeded' | 'failed' | 'timed_out',
    now: number,
    error: string | null,
  ): void {
    const reply = run.conversationId ? this.log.lastAssistantText(run.conversationId) : null
    this.ctx.db
      .update(scheduledRuns)
      .set({
        status,
        finishedAt: now,
        error,
        summary: reply ? clip(reply, SUMMARY_MAX_CHARS) : null,
      })
      .where(eq(scheduledRuns.id, run.id))
      .run()
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`
}

/** Compact server-local date and time for run titles. */
function stamp(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const RUN_OUTCOMES: Record<ScheduledRunRow['status'], string> = {
  checking: 'en vérification',
  running: 'encore en cours',
  succeeded: 'terminé normalement',
  failed: 'en échec',
  timed_out: 'interrompu pour durée maximale dépassée',
  skipped: 'sauté',
}

/** First run message: agent situation followed by task prompt. Written for the model in French like other Sillage injections. First state that nobody is at the keyboard: questions or permission waits would otherwise hang until maximum duration. Fresh sessions lack previous-run context; its date, conversation link and last answer provide minimal continuity, supplemented by project memory and cards. Prompts may interpolate `{{date}}`, `{{previous_run_date}}`, `{{previous_run_url}}` and `{{previous_run_summary}}` anywhere. */
export function buildRunPrompt(input: {
  task: Pick<ScheduledTaskRow, 'name' | 'prompt' | 'projectId' | 'maxDurationMinutes'>
  trigger: ScheduleRunTrigger
  firedAt: number
  previous: Pick<ScheduledRunRow, 'startedAt' | 'status' | 'conversationId' | 'summary' | 'error'> | null
  publicUrl: string
  /** Check output when it allowed the turn to proceed. */
  checkOutput?: string | null
}): string {
  const { task, trigger, firedAt, previous, publicUrl } = input
  const checkOutput = input.checkOutput?.trim() ?? ''
  const date = stamp(firedAt)
  const previousDate = previous ? stamp(previous.startedAt) : ''
  const previousUrl = previous?.conversationId
    ? `${publicUrl.replace(/\/+$/, '')}/p/${task.projectId}/c/${previous.conversationId}`
    : ''
  const previousSummary = previous?.summary ?? ''

  const header = [
    `[Tâche planifiée Sillage « ${task.name} » — tir du ${date}${trigger === 'manual' ? ', lancé à la main' : ''}]`,
    '',
    `Tu tournes seul, dans une session neuve ouverte par le planificateur de Sillage : personne n'est au clavier. Ne pose pas de question et ne demande pas de confirmation, personne n'y répondrait : décide, et note tes hypothèses dans ta réponse finale. Ce qui demande un accord ou sort de la consigne, ouvre une carte (create_card) plutôt que de le faire. Le tir est interrompu au bout de ${task.maxDurationMinutes} min. Ta dernière réponse sera transmise au tir suivant : fais-en un compte rendu court de ce que tu as trouvé et fait.`,
    '',
  ]

  if (previous) {
    header.push(
      `Tir précédent : ${previousDate}, ${RUN_OUTCOMES[previous.status]}${previous.error ? ` (${previous.error})` : ''}.`,
    )
    if (previous.conversationId) {
      header.push(`Son fil : ${previousUrl} (read_conversation avec l'id ${previous.conversationId} pour le lire).`)
    }
    header.push(
      previousSummary
        ? `Sa dernière réponse :\n${previousSummary.replace(/^/gm, '> ')}`
        : "Il n'a laissé aucune réponse.",
    )
  } else {
    header.push("C'est le premier tir de cette tâche.")
  }

  // Check findings justify this turn: include them even when instructions omit
  // them, avoiding duplication when instructions already include them.
  if (checkOutput && !/\{\{\s*check_output\s*\}\}/.test(task.prompt)) {
    header.push('', 'Le script de vérification de la tâche a laissé partir ce tour. Sa sortie :', '```', checkOutput, '```')
  }

  const variables: Record<string, string> = {
    date,
    previous_run_date: previousDate,
    previous_run_url: previousUrl,
    previous_run_summary: previousSummary,
    check_output: checkOutput,
  }
  const prompt = task.prompt.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => variables[key] ?? whole)

  return `${header.join('\n')}\n\n---\n\n${prompt}`
}
