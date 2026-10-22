import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { conversations, projects, type ProjectActionRow } from '@sillage/db'
import {
  createProjectActionBodySchema,
  runProjectActionBodySchema,
  serviceActionControlSchema,
  updateProjectActionBodySchema,
  type ProjectActionDto,
} from '@sillage/protocol'
import {
  approveAction,
  createAction,
  deleteAction,
  listActionRows,
  loadAction,
  updateAction,
  type ActionRunner,
} from '../../actions/actions.js'
import type { SessionManager } from '../../sessions/session-manager.js'
import type { AppContext } from '../context.js'
import { conflict, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'
import { visibilityFilter, visibleProject } from './projects.js'

/**
 * Project actions.
 *
 * Same permissions as terminals: project viewers can launch and edit actions.
 * Actions execute nothing unavailable in that project's terminal; agents can
 * write them, however, so review is mandatory before a click can run them.
 */
export function registerActionRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  sessions: SessionManager,
  runner: ActionRunner,
): void {
  const guardProject = (projectId: string, userId: string) => {
    const project = visibleProject(ctx, projectId, userId)
    if (!project) throw notFound('project_not_found', 'Project not found.')
    return project
  }

  const guardAction = (actionId: string, userId: string) => {
    const action = loadAction(ctx.db, actionId)
    const project = guardProject(action.projectId, userId)
    return { action, project }
  }

  /** Conversation worktree when supplied and in the same project; otherwise the root. */
  const baseDir = (action: ProjectActionRow, workspacePath: string, conversationId?: string) => {
    if (!conversationId) return workspacePath
    const row = ctx.db
      .select({ projectId: conversations.projectId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get()
    if (!row || row.projectId !== action.projectId) {
      throw notFound('conversation_not_found', 'Conversation not found.')
    }
    return sessions.workingDirectory(conversationId)
  }

  /** All visible actions: the palette offers them across projects. */
  app.get('/api/actions', async (request): Promise<ProjectActionDto[]> => {
    const user = requireUser(request)
    const visible = ctx.db.select({ id: projects.id }).from(projects).where(visibilityFilter(user.id)).all()
    return runner.toDtos(listActionRows(ctx.db, visible.map((project) => project.id)))
  })

  app.post('/api/projects/:id/actions', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    guardProject(id, user.id)
    const body = createProjectActionBodySchema.parse(request.body)
    const row = createAction(ctx.db, id, body, null)
    return reply.status(201).send(await runner.toDto(row))
  })

  app.patch('/api/actions/:id', async (request): Promise<ProjectActionDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { action } = guardAction(id, user.id)
    const patch = updateProjectActionBodySchema.parse(request.body)
    // Turning a service into a task would leave its unit running without a button.
    if (action.kind === 'service' && patch.kind === 'task') await runner.forget(action)
    return runner.toDto(updateAction(ctx.db, action, patch, null))
  })

  app.post('/api/actions/:id/approve', async (request): Promise<ProjectActionDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { action } = guardAction(id, user.id)
    return runner.toDto(approveAction(ctx.db, action))
  })

  app.delete('/api/actions/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { action } = guardAction(id, user.id)
    await runner.forget(action)
    deleteAction(ctx.db, id)
    return reply.status(204).send()
  })

  app.post('/api/actions/:id/run', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { action, project } = guardAction(id, user.id)
    const body = runProjectActionBodySchema.parse(request.body ?? {})
    if (!action.approvedAt) {
      throw conflict('action_not_approved', 'Review this action before running it.')
    }
    const result = await runner.run(action, baseDir(action, project.workspacePath, body.conversationId), body.conversationId ?? null)
    return reply.status(result.alreadyRunning ? 200 : 201).send(result)
  })

  app.post('/api/actions/:id/service/:op', async (request) => {
    const user = requireUser(request)
    const { id, op } = request.params as { id: string; op: string }
    const { action, project } = guardAction(id, user.id)
    const body = runProjectActionBodySchema.parse(request.body ?? {})
    const base = baseDir(action, project.workspacePath, body.conversationId)
    if (op === 'logs') return runner.logs(action, base)
    // Restarting a stopped service is another launch and requires the same review.
    if (op === 'restart' && !action.approvedAt) {
      throw conflict('action_not_approved', 'Review this action before running it.')
    }
    return runner.control(action, serviceActionControlSchema.parse(op), base)
  })
}
