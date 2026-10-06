import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNotNull, isNull, lte, ne } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import {
  conversations,
  projects,
  scheduledRuns,
  scheduledTasks,
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
import { readCadence } from './tasks.js'

/**
 * Tire les tâches planifiées : à l'heure voulue, ouvre une session neuve dans le projet
 * avec le prompt de la tâche, puis la suit jusqu'à sa fin ou jusqu'à sa durée maximale.
 *
 * Un balayage de la base plutôt qu'un `Cron` armé par tâche, comme le `Scheduler` des
 * ménages : l'état vit dans `next_run_at`, donc une tâche créée, modifiée ou mise en
 * pause par une route ou par l'outil MCP est prise en compte au balayage suivant sans
 * rien avoir à réarmer, et un tir manqué pendant un arrêt du daemon se voit au
 * redémarrage au lieu d'être perdu.
 */

const TICK_MS = 5000

/** Résumé du tir précédent recopié dans le prompt du suivant. */
const SUMMARY_MAX_CHARS = 2000

export class TaskScheduler {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private logger: FastifyBaseLogger | null = null
  /**
   * Tâches dont un tir est en train de partir. Le lancement attend le CLI plusieurs
   * secondes, pendant lesquelles « lancer maintenant » ne doit pas en ouvrir un second.
   */
  private readonly firing = new Set<string>()

  constructor(
    private readonly ctx: AppContext,
    private readonly sessions: SessionManager,
    private readonly registry: AgentRegistry,
    private readonly log: EventLog,
  ) {}

  start(logger: FastifyBaseLogger): void {
    this.logger = logger
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
      // Les tirs en cours d'abord : un tir qui vient de finir libère la place pour
      // celui qui attendait derrière lui, dans le même balayage.
      await this.settleRuns(now)
      await this.fireDue(now)
    } catch (err) {
      this.logger?.error({ err }, 'balayage des tâches planifiées en échec')
    } finally {
      this.busy = false
    }
  }

  /**
   * « Lancer maintenant ». Ne décale pas le prochain tir prévu : c'est un essai, pas un
   * changement de cadence.
   */
  async runNow(taskId: string): Promise<ScheduledRunRow> {
    const task = this.ctx.db.select().from(scheduledTasks).where(eq(scheduledTasks.id, taskId)).get()
    if (!task) throw new HttpError(404, 'schedule_not_found', 'Scheduled task not found.')
    if (this.firing.has(task.id) || this.openRun(task.id)) {
      throw conflict('schedule_already_running', 'A run of this task is still in progress.')
    }
    const now = Date.now()
    return this.fire(task, 'manual', now, now)
  }

  // --- Tirs à l'heure ------------------------------------------------------------

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
          // Un projet rangé ne travaille plus : ses tâches attendent son retour.
          isNull(projects.archivedAt),
        ),
      )
      .all()

    for (const { task } of due) {
      if (this.firing.has(task.id)) continue
      const scheduledFor = task.nextRunAt ?? now

      if (this.openRun(task.id)) {
        // `wait` : la tâche reste due, et partira au balayage qui trouvera la place
        // libre. Une ponctuelle attend toujours, la sauter reviendrait à la perdre.
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

      await this.fire(task, 'schedule', scheduledFor, now)
    }
  }

  private openRun(taskId: string): ScheduledRunRow | undefined {
    return this.ctx.db
      .select()
      .from(scheduledRuns)
      .where(and(eq(scheduledRuns.taskId, taskId), eq(scheduledRuns.status, 'running')))
      .get()
  }

  /** Arme le tir suivant ; une ponctuelle a fait son office et se met en pause. */
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
    /**
     * L'instant du balayage, et non une seconde lecture de l'horloge : le tir suivant
     * s'arme depuis la même date que celle qui a jugé celui-ci dû.
     */
    startedAt: number,
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
    }

    try {
      // Avancée avant le lancement : si le CLI refuse de démarrer, la tâche ne doit pas
      // rester due et retenter toutes les cinq secondes.
      this.ctx.db.update(scheduledTasks).set({ lastRunAt: startedAt }).where(eq(scheduledTasks.id, task.id)).run()
      if (trigger === 'schedule') this.advance(task, startedAt)

      const config = await this.registry.adapter(task.agent).resolveDefaults(parseAgentConfig(task.config))
      const row = await createConversation(this.ctx.db, this.sessions, {
        projectId: task.projectId,
        userId: task.userId,
        agent: task.agent,
        config,
        worktreeId: null,
        cardId: null,
        // Le nom de la tâche et l'heure : sous sa tâche, c'est la date qui distingue
        // un tir du précédent, et ailleurs (recherche, favoris) c'est le nom.
        title: `${task.name} · ${stamp(startedAt)}`,
        origin: null,
        scheduleId: task.id,
        firstMessage: {
          clientMessageId: randomUUID(),
          text: buildRunPrompt({
            task,
            trigger,
            firedAt: startedAt,
            previous: this.previousRun(task.id),
            publicUrl: this.ctx.config.server.publicUrl,
          }),
          attachments: [],
          mentions: [],
          skills: [],
        },
      })
      run.conversationId = row.id
    } catch (err) {
      run.status = 'failed'
      run.finishedAt = Date.now()
      run.error = `Lancement impossible : ${err instanceof Error ? err.message : String(err)}`
      this.logger?.warn({ err, task: task.id }, 'tir planifié en échec au lancement')
    } finally {
      this.firing.delete(task.id)
    }

    this.ctx.db.insert(scheduledRuns).values(run).run()
    return run
  }

  /** Le dernier tir qui a réellement ouvert une session, celui dont le suivant hérite. */
  private previousRun(taskId: string): ScheduledRunRow | null {
    return (
      this.ctx.db
        .select()
        .from(scheduledRuns)
        .where(and(eq(scheduledRuns.taskId, taskId), ne(scheduledRuns.status, 'skipped'), ne(scheduledRuns.status, 'running')))
        .orderBy(desc(scheduledRuns.startedAt))
        .limit(1)
        .get() ?? null
    )
  }

  // --- Suivi des tirs en cours ---------------------------------------------------

  /**
   * Clôt les tirs dont la session a fini, et coupe ceux qui débordent.
   *
   * « Fini » se lit comme pour `notify_when_done` : plus de tour, de travail de fond ni
   * de boucle. Une sollicitation en attente n'est pas une fin : personne n'est là pour
   * y répondre, mais quelqu'un peut passer, et la durée maximale tranchera sinon.
   */
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
      // Le dernier mot du journal, pour un fil au repos : entre la création et le
      // premier statut du CLI, le fil est `idle` sans avoir rien fait, et le prendre
      // pour fini clôturerait le tir à sa naissance.
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

/** Date et heure locales du serveur, compactes : c'est ce qui titre un tir. */
function stamp(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const RUN_OUTCOMES: Record<ScheduledRunRow['status'], string> = {
  running: 'encore en cours',
  succeeded: 'terminé normalement',
  failed: 'en échec',
  timed_out: 'interrompu pour durée maximale dépassée',
  skipped: 'sauté',
}

/**
 * Le premier message d'un tir : ce que l'agent doit savoir de sa situation, puis le
 * prompt de la tâche.
 *
 * Rédigé pour le modèle, en français comme le reste de ce que Sillage injecte. Il dit
 * d'abord que personne n'est au clavier : un agent qui pose une question ou attend une
 * permission resterait suspendu jusqu'à la durée maximale, pour rien.
 *
 * Une session neuve ne sait rien du tir précédent. Sa date, son fil et sa dernière
 * réponse sont la continuité minimale ; le reste passe par la mémoire du projet et les
 * cartes. Le prompt peut aussi les citer où il veut par `{{date}}`,
 * `{{previous_run_date}}`, `{{previous_run_url}}` et `{{previous_run_summary}}`.
 */
export function buildRunPrompt(input: {
  task: Pick<ScheduledTaskRow, 'name' | 'prompt' | 'projectId' | 'maxDurationMinutes'>
  trigger: ScheduleRunTrigger
  firedAt: number
  previous: Pick<ScheduledRunRow, 'startedAt' | 'status' | 'conversationId' | 'summary' | 'error'> | null
  publicUrl: string
}): string {
  const { task, trigger, firedAt, previous, publicUrl } = input
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

  const variables: Record<string, string> = {
    date,
    previous_run_date: previousDate,
    previous_run_url: previousUrl,
    previous_run_summary: previousSummary,
  }
  const prompt = task.prompt.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => variables[key] ?? whole)

  return `${header.join('\n')}\n\n---\n\n${prompt}`
}
