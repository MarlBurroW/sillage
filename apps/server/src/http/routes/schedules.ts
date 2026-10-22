import { rm } from 'node:fs/promises'
import { and, asc, desc, eq, isNotNull, or } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { publicUrlOf } from '../../settings/app-settings.js'
import { automationWebhooks, projects, scheduledRuns, scheduledTasks, type ScheduledTaskRow } from '@sillage/db'
import {
  AUTOMATION_TEMPLATES,
  approveScheduleCheckBodySchema,
  createScheduledTaskBodySchema,
  runScheduleBodySchema,
  testScheduleCheckBodySchema,
  updateScheduledTaskBodySchema,
  type ScheduleCheckResultDto,
  type ScheduledTaskDto,
} from '@sillage/protocol'
import type { AgentRegistry } from '../../agents/registry.js'
import type { AutomationReceiver } from '../../automations/receiver.js'
import { createWebhook } from '../../automations/webhooks.js'
import { checkStateDir, runCheck } from '../../scheduler/check.js'
import type { TaskScheduler } from '../../scheduler/task-scheduler.js'
import {
  approveScheduleCheck,
  createScheduledTask,
  deleteScheduledTask,
  readCadence,
  runToDto,
  tasksToDto,
  updateScheduledTask,
} from '../../scheduler/tasks.js'
import type { SessionManager } from '../../sessions/session-manager.js'
import type { AppContext } from '../context.js'
import { badRequest, forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/** Project scheduled tasks. Project viewers may read them, like conversations. Only their creator or project owner may edit: runs use the creator's identity and selected permissions, which another account must not expand on their behalf. */
export function registerScheduleRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  sessions: SessionManager,
  registry: AgentRegistry,
  tasks: TaskScheduler,
  automations: AutomationReceiver,
): void {
  // Read on every call: configuration may be missing at registration time.
  const publicUrl = () => publicUrlOf(ctx.db, ctx.config)
  const loadProject = (projectId: string, userId: string) => {
    const project = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project || (project.ownerId !== userId && project.visibility !== 'shared')) {
      throw notFound('project_not_found', 'Project not found.')
    }
    return project
  }

  const loadWritable = (taskId: string, userId: string): ScheduledTaskRow => {
    const task = ctx.db.select().from(scheduledTasks).where(eq(scheduledTasks.id, taskId)).get()
    if (!task) throw notFound('schedule_not_found', 'Scheduled task not found.')
    const project = loadProject(task.projectId, userId)
    if (task.userId !== userId && project.ownerId !== userId) {
      throw forbidden('schedule_write_forbidden', 'Only the task creator or the project owner can change it.')
    }
    return task
  }

  const one = (row: ScheduledTaskRow): ScheduledTaskDto => tasksToDto(ctx.db, [row], publicUrl())[0]!

  /** All visible tasks across projects; the sidebar groups them by project. */
  app.get('/api/schedules', async (request): Promise<ScheduledTaskDto[]> => {
    const user = requireUser(request)
    const rows = ctx.db
      .select({ task: scheduledTasks })
      .from(scheduledTasks)
      .innerJoin(projects, eq(projects.id, scheduledTasks.projectId))
      .where(or(eq(projects.ownerId, user.id), eq(projects.visibility, 'shared')))
      .orderBy(asc(scheduledTasks.createdAt))
      .all()
    return tasksToDto(
      ctx.db,
      rows.map((row) => row.task),
      publicUrl(),
    )
  })

  app.post('/api/projects/:id/schedules', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = createScheduledTaskBodySchema.parse(request.body)
    loadProject(id, user.id)

    // As with conversation creation, retain explicit settings rather than a 'CLI default'
    // whose meaning could change between runs.
    const config = await registry.adapter(body.agent).resolveDefaults(body.config)
    // Create the task and webhook together: automation without an address would never
    // receive anything and would remain silently broken.
    const row = ctx.db.transaction(() => {
      const created = createScheduledTask(ctx.db, { projectId: id, userId: user.id }, { ...body, config })
      if (body.cadence.kind === 'webhook') {
        const template = AUTOMATION_TEMPLATES.find((entry) => entry.id === body.webhook?.template)
        createWebhook(ctx.db, automations.key, created.id, { ...template?.settings, ...body.webhook?.settings }, template?.id ?? null)
      }
      return created
    })
    return reply.status(201).send(one(row))
  })

  app.patch('/api/schedules/:id', async (request): Promise<ScheduledTaskDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = updateScheduledTaskBodySchema.parse(request.body)
    const task = loadWritable(id, user.id)
    // Schedules and webhooks cannot be swapped: one has a time, the other an address
    // and journal. Create another instead of losing either along the way.
    if (body.cadence && (body.cadence.kind === 'webhook') !== (readCadence(task.cadence).kind === 'webhook')) {
      throw badRequest('automation_trigger_fixed', 'A scheduled task cannot become a webhook automation, or the reverse.')
    }
    // Re-enabling after the circuit breaker trips resets it.
    if (body.enabled) {
      ctx.db.update(automationWebhooks).set({ trippedAt: null }).where(eq(automationWebhooks.taskId, task.id)).run()
    }

    const config = body.config
      ? await registry.adapter(body.agent ?? task.agent).resolveDefaults(body.config)
      : undefined
    return one(updateScheduledTask(ctx.db, task, { ...body, config }))
  })

  app.delete('/api/schedules/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    loadWritable(id, user.id)

    const running = deleteScheduledTask(ctx.db, id)
    // An in-flight run loses its bounds when its task disappears, so stop it too.
    await Promise.all(running.map((conversationId) => sessions.terminate(conversationId)))
    // State retained by its check between runs is no longer needed.
    await rm(checkStateDir(ctx.config.paths.data, id), { recursive: true, force: true })
    return reply.status(204).send()
  })

  /** 'Run now': an out-of-cycle run that leaves the next scheduled run unchanged. */
  app.post('/api/schedules/:id/run', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    loadWritable(id, user.id)
    const body = runScheduleBodySchema.parse(request.body ?? {})
    return reply.status(201).send(runToDto(await tasks.runNow(id, { skipCheck: body.skipCheck })))
  })

  /** Runs the form's check script, saved or unsaved, without launching anything. This executes server code and requires permission to edit the task or create one in the project. State retained between runs remains untouched. */
  app.post('/api/projects/:id/schedules/check-test', async (request): Promise<ScheduleCheckResultDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = testScheduleCheckBodySchema.parse(request.body)
    const project = loadProject(id, user.id)
    const task = body.taskId ? loadWritable(body.taskId, user.id) : null
    if (task && task.projectId !== project.id) throw notFound('schedule_not_found', 'Scheduled task not found.')
    const previous = task
      ? ctx.db
          .select({ startedAt: scheduledRuns.startedAt, status: scheduledRuns.status })
          .from(scheduledRuns)
          .where(and(eq(scheduledRuns.taskId, task.id), isNotNull(scheduledRuns.conversationId)))
          .orderBy(desc(scheduledRuns.startedAt))
          .get()
      : undefined
    return runCheck(body.script, {
      taskId: task?.id ?? '',
      taskName: task?.name ?? '',
      projectId: project.id,
      cwd: project.workspacePath,
      // Without a task, use an empty directory: the trial copies it without writing to it.
      stateDir: checkStateDir(ctx.config.paths.data, task?.id ?? '_draft'),
      firedAt: Date.now(),
      trigger: 'test',
      previous: previous ?? null,
      timeoutMs: body.timeoutSeconds * 1000,
    })
  })

  /** Approves the exact agent-proposed script that was reviewed. */
  app.post('/api/schedules/:id/check/approve', async (request): Promise<ScheduledTaskDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = approveScheduleCheckBodySchema.parse(request.body)
    return one(approveScheduleCheck(ctx.db, loadWritable(id, user.id), body.script))
  })
}
