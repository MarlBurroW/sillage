import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray } from 'drizzle-orm'
import {
  automationWebhooks,
  conversations,
  scheduledRuns,
  scheduledTasks,
  type Db,
  type ScheduledRunRow,
  type ScheduledTaskRow,
} from '@sillage/db'
import {
  DEFAULT_DECISION_HOURS,
  DEFAULT_CHECK_TIMEOUT_SECONDS,
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
import { webhookToDto } from '../automations/webhooks.js'
import { badRequest, conflict, notFound } from '../http/errors.js'

/** Scheduled-task reads and writes shared by interface routes and MCP `schedule_task`; duplicate implementations would arm tasks differently. */

/** Runs included with tasks to populate history without another call. */
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
    // Always set duration after running scripts, even when killed before exit codes.
    check:
      row.checkDurationMs === null
        ? null
        : {
            exitCode: row.checkExitCode,
            stdout: row.checkOutput ?? '',
            stderr: row.checkStderr ?? '',
            durationMs: row.checkDurationMs,
          },
  }
}

export function tasksToDto(db: Db, rows: ScheduledTaskRow[], publicUrl: string): ScheduledTaskDto[] {
  if (rows.length === 0) return []
  const hooks = new Map(
    db
      .select()
      .from(automationWebhooks)
      .where(inArray(automationWebhooks.taskId, rows.map((row) => row.id)))
      .all()
      .map((hook) => [hook.taskId, hook]),
  )
  // One query per task rather than a global window: there are few tasks,
  // and the (task_id, started_at) index makes each query immediate.
  return rows.map((row) => {
    const runs = db
      .select()
      .from(scheduledRuns)
      .where(eq(scheduledRuns.taskId, row.id))
      .orderBy(desc(scheduledRuns.startedAt))
      .limit(RUNS_PER_TASK)
      .all()
    // Deleted conversations must not leave broken history links:
    // retain runs without their conversations.
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
      decisionsEnabled: row.decisionsEnabled,
      decisionMaxHours: row.decisionMaxHours,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      runs: runs.map((run) => ({
        ...runToDto(run),
        conversationId: run.conversationId && alive.has(run.conversationId) ? run.conversationId : null,
      })),
      webhook: hooks.has(row.id) ? webhookToDto(hooks.get(row.id)!, publicUrl) : null,
      check: row.checkScript
        ? {
            script: row.checkScript,
            timeoutSeconds: row.checkTimeoutSeconds,
            approved: row.checkApprovedAt !== null,
            proposedBy: row.checkProposedBy,
          }
        : null,
    }
  })
}

export interface ScheduledTaskInput {
  name: string
  agent: AgentKind
  /** Already resolved: replace `CLI_DEFAULT` before writing. */
  config: AgentConfig
  prompt: string
  cadence: ScheduleCadence
  overlapPolicy: ScheduleOverlapPolicy
  maxDurationMinutes: number
  enabled: boolean
  /** Null means no pre-turn check. */
  checkScript?: string | null
  checkTimeoutSeconds?: number
  /** Whether agents can request human decisions; disabled by default. */
  decisionsEnabled?: boolean
  decisionMaxHours?: number
}

function assertCoherent(agent: AgentKind, config: AgentConfig): void {
  if (config.agent !== agent) {
    throw badRequest('config_agent_mismatch', 'The configuration does not match the selected CLI.')
  }
}

/** Next run to arm, or an error explaining its absence. Active tasks without future runs would silently never execute, so reject them on write. */
function armedAt(cadence: ScheduleCadence, enabled: boolean, lastRunAt: number | null): number | null {
  // Webhooks have no schedule: calls trigger runs.
  if (!enabled || cadence.kind === 'webhook') return null
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
    checkScript: input.checkScript ?? null,
    checkTimeoutSeconds: input.checkTimeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS,
    // Interface-written scripts have been read by their author;
    // agent-written scripts await human review.
    checkApprovedAt: input.checkScript && !owner.conversationId ? now : null,
    checkProposedBy: input.checkScript && owner.conversationId ? owner.conversationId : null,
    decisionsEnabled: input.decisionsEnabled ?? false,
    decisionMaxHours: input.decisionMaxHours ?? DEFAULT_DECISION_HOURS,
    lastRunAt: null,
    nextRunAt: armedAt(input.cadence, input.enabled, null),
    createdAt: now,
    updatedAt: now,
  }
  db.insert(scheduledTasks).values(row).run()
  return row
}

/** Edits tasks. Null `agentConversationId` means interface edits, where saving counts as review. Agent-modified scripts become proposals again, like project action commands. */
export function updateScheduledTask(
  db: Db,
  current: ScheduledTaskRow,
  patch: Partial<ScheduledTaskInput>,
  agentConversationId: string | null = null,
): ScheduledTaskRow {
  const agent = patch.agent ?? current.agent
  const config = patch.config ?? parseAgentConfig(current.config)
  assertCoherent(agent, config)

  const cadence = patch.cadence ?? readCadence(current.cadence)
  const enabled = patch.enabled ?? current.enabled
  // Rearm only when cadence or pause changes: renaming must not postpone
  // an approaching interval run.
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
    checkTimeoutSeconds: patch.checkTimeoutSeconds ?? current.checkTimeoutSeconds,
    decisionsEnabled: patch.decisionsEnabled ?? current.decisionsEnabled,
    decisionMaxHours: patch.decisionMaxHours ?? current.decisionMaxHours,
    updatedAt: Date.now(),
  }
  if (patch.checkScript !== undefined && patch.checkScript !== current.checkScript) {
    next.checkScript = patch.checkScript
    next.checkApprovedAt = patch.checkScript && !agentConversationId ? next.updatedAt : null
    next.checkProposedBy = patch.checkScript && agentConversationId ? agentConversationId : null
  }
  db.update(scheduledTasks).set(next).where(eq(scheduledTasks.id, current.id)).run()
  return next
}

/** Approves exactly the reviewed script. If changed since display, approve nothing: otherwise unseen content would be approved. */
export function approveScheduleCheck(db: Db, task: ScheduledTaskRow, reviewed: string): ScheduledTaskRow {
  if (!task.checkScript) throw notFound('schedule_check_missing', 'This task has no check script.')
  if (task.checkScript !== reviewed) {
    throw conflict('schedule_check_changed', 'The check script changed since it was displayed: review it again.')
  }
  const next = { ...task, checkApprovedAt: Date.now(), checkProposedBy: null }
  db.update(scheduledTasks)
    .set({ checkApprovedAt: next.checkApprovedAt, checkProposedBy: null })
    .where(and(eq(scheduledTasks.id, task.id), eq(scheduledTasks.checkScript, reviewed)))
    .run()
  return next
}

/** Deletes tasks and archives their now-ordinary conversations. Otherwise hourly runs would flood the main list after leaving their scheduled section, defeating `schedule_id`. Returns still-active conversations for callers to stop because nothing will monitor them anymore. */
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
  // Runs cascade on deletion.
  db.delete(scheduledTasks).where(eq(scheduledTasks.id, taskId)).run()

  return threads
    .filter((thread) => thread.status === 'running' || thread.status === 'awaiting_input')
    .map((thread) => thread.id)
}
