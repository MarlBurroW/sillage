import { randomUUID } from 'node:crypto'
import { desc, eq, inArray } from 'drizzle-orm'
import {
  conversations,
  scheduledRuns,
  scheduledTasks,
  type Db,
  type ScheduledRunRow,
  type ScheduledTaskRow,
} from '@sillage/db'
import {
  nextScheduleRun,
  parseAgentConfig,
  scheduleCadenceSchema,
  type AgentConfig,
  type AgentKind,
  type ScheduleCadence,
  type ScheduleOverlapPolicy,
  type ScheduledRunDto,
  type ScheduledTaskDto,
} from '@sillage/protocol'
import { badRequest } from '../http/errors.js'

/**
 * Lecture et écriture des tâches planifiées, partagées entre les routes de l'interface
 * et l'outil MCP `schedule_task` : deux copies auraient armé différemment la même tâche.
 */

/** Tirs rendus avec une tâche : de quoi remplir son historique sans second appel. */
const RUNS_PER_TASK = 20

export function readCadence(raw: string): ScheduleCadence {
  return scheduleCadenceSchema.parse(JSON.parse(raw))
}

export function runToDto(row: ScheduledRunRow): ScheduledRunDto {
  return {
    id: row.id,
    taskId: row.taskId,
    conversationId: row.conversationId,
    trigger: row.trigger,
    status: row.status,
    scheduledFor: row.scheduledFor,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    error: row.error,
  }
}

export function tasksToDto(db: Db, rows: ScheduledTaskRow[]): ScheduledTaskDto[] {
  if (rows.length === 0) return []
  // Une requête par tâche plutôt qu'une fenêtre sur toutes : elles se comptent sur les
  // doigts, et l'index (task_id, started_at) rend chacune immédiate.
  return rows.map((row) => {
    const runs = db
      .select()
      .from(scheduledRuns)
      .where(eq(scheduledRuns.taskId, row.id))
      .orderBy(desc(scheduledRuns.startedAt))
      .limit(RUNS_PER_TASK)
      .all()
    // Un fil supprimé depuis ne doit pas laisser dans l'historique un lien qui ne mène
    // nulle part : le tir reste, sans sa conversation.
    const threadIds = runs.flatMap((run) => (run.conversationId ? [run.conversationId] : []))
    const alive = new Set(
      threadIds.length > 0
        ? db
            .select({ id: conversations.id })
            .from(conversations)
            .where(inArray(conversations.id, threadIds))
            .all()
            .map((thread) => thread.id)
        : [],
    )
    return {
      id: row.id,
      projectId: row.projectId,
      userId: row.userId,
      name: row.name,
      agent: row.agent,
      config: parseAgentConfig(row.config),
      prompt: row.prompt,
      cadence: readCadence(row.cadence),
      executionMode: row.executionMode,
      overlapPolicy: row.overlapPolicy,
      maxDurationMinutes: row.maxDurationMinutes,
      enabled: row.enabled,
      lastRunAt: row.lastRunAt,
      nextRunAt: row.nextRunAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      runs: runs.map((run) => ({
        ...runToDto(run),
        conversationId: run.conversationId && alive.has(run.conversationId) ? run.conversationId : null,
      })),
    }
  })
}

export interface ScheduledTaskInput {
  name: string
  agent: AgentKind
  /** Déjà résolue : les `CLI_DEFAULT` sont remplacés avant l'écriture. */
  config: AgentConfig
  prompt: string
  cadence: ScheduleCadence
  overlapPolicy: ScheduleOverlapPolicy
  maxDurationMinutes: number
  enabled: boolean
}

function assertCoherent(agent: AgentKind, config: AgentConfig): void {
  if (config.agent !== agent) {
    throw badRequest('config_agent_mismatch', 'The configuration does not match the selected CLI.')
  }
}

/**
 * Prochain tir à armer, ou l'erreur qui dit pourquoi il n'y en a pas.
 *
 * Une tâche active sans prochain tir est une tâche qui ne partira jamais sans le dire :
 * autant la refuser à l'écriture.
 */
function armedAt(cadence: ScheduleCadence, enabled: boolean, lastRunAt: number | null): number | null {
  if (!enabled) return null
  const next = nextScheduleRun(cadence, Date.now(), lastRunAt)
  if (next === null) {
    throw badRequest('schedule_never_fires', 'This schedule has no upcoming run.')
  }
  return next
}

export function createScheduledTask(
  db: Db,
  owner: { projectId: string; userId: string; conversationId?: string },
  input: ScheduledTaskInput,
): ScheduledTaskRow {
  assertCoherent(input.agent, input.config)
  const now = Date.now()
  const row: ScheduledTaskRow = {
    id: randomUUID(),
    projectId: owner.projectId,
    userId: owner.userId,
    name: input.name,
    agent: input.agent,
    config: JSON.stringify(input.config),
    prompt: input.prompt,
    cadence: JSON.stringify(input.cadence),
    executionMode: 'fresh',
    overlapPolicy: input.overlapPolicy,
    maxDurationMinutes: input.maxDurationMinutes,
    enabled: input.enabled,
    createdByConversationId: owner.conversationId ?? null,
    lastRunAt: null,
    nextRunAt: armedAt(input.cadence, input.enabled, null),
    createdAt: now,
    updatedAt: now,
  }
  db.insert(scheduledTasks).values(row).run()
  return row
}

export function updateScheduledTask(
  db: Db,
  current: ScheduledTaskRow,
  patch: Partial<ScheduledTaskInput>,
): ScheduledTaskRow {
  const agent = patch.agent ?? current.agent
  const config = patch.config ?? parseAgentConfig(current.config)
  assertCoherent(agent, config)

  const cadence = patch.cadence ?? readCadence(current.cadence)
  const enabled = patch.enabled ?? current.enabled
  // Réarmée seulement si la cadence ou la pause ont bougé : renommer une tâche ne doit
  // pas repousser un tir par intervalle qui approchait.
  const rearm = patch.cadence !== undefined || enabled !== current.enabled
  const next: ScheduledTaskRow = {
    ...current,
    name: patch.name ?? current.name,
    agent,
    config: JSON.stringify(config),
    prompt: patch.prompt ?? current.prompt,
    cadence: JSON.stringify(cadence),
    overlapPolicy: patch.overlapPolicy ?? current.overlapPolicy,
    maxDurationMinutes: patch.maxDurationMinutes ?? current.maxDurationMinutes,
    enabled,
    nextRunAt: rearm ? armedAt(cadence, enabled, current.lastRunAt) : current.nextRunAt,
    updatedAt: Date.now(),
  }
  db.update(scheduledTasks).set(next).where(eq(scheduledTasks.id, current.id)).run()
  return next
}

/**
 * Supprime une tâche et rend ses fils à la vie ordinaire, rangés.
 *
 * Rangés plutôt que laissés actifs : sortis de leur section, les tirs d'une tâche
 * horaire déferleraient d'un coup dans la liste principale, ce que la colonne
 * `schedule_id` servait justement à éviter. Renvoie les fils encore en cours, que
 * l'appelant doit arrêter : plus rien ne les surveillera.
 */
export function deleteScheduledTask(db: Db, taskId: string): string[] {
  const threads = db
    .select({ id: conversations.id, status: conversations.status, archivedAt: conversations.archivedAt })
    .from(conversations)
    .where(eq(conversations.scheduleId, taskId))
    .all()

  const now = Date.now()
  const fresh = threads.filter((thread) => thread.archivedAt === null).map((thread) => thread.id)
  if (fresh.length > 0) {
    db.update(conversations).set({ archivedAt: now }).where(inArray(conversations.id, fresh)).run()
  }
  db.update(conversations).set({ scheduleId: null }).where(eq(conversations.scheduleId, taskId)).run()
  // Les tirs partent avec elle, par cascade.
  db.delete(scheduledTasks).where(eq(scheduledTasks.id, taskId)).run()

  return threads
    .filter((thread) => thread.status === 'running' || thread.status === 'awaiting_input')
    .map((thread) => thread.id)
}
