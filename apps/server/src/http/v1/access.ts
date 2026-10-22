import { and, eq } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import { conversations, projects, worktrees, type ApiTokenRow, type ProjectRow } from '@sillage/db'
import { publicUrlOf } from '../../settings/app-settings.js'
import type { AppContext } from '../context.js'
import { badRequest, notFound } from '../errors.js'

/**
 * Resources reachable by a token.
 *
 * Always combine both filters: what its user can already see and the token's
 * project allowlist. A token borrows an identity without expanding it; limiting
 * projects is the real safeguard when handing it to a third party.
 */
export function loadProjectForToken(
  ctx: AppContext,
  token: ApiTokenRow,
  userId: string,
  projectId: string,
): ProjectRow {
  const project = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project) throw notFound('project_not_found', 'Project not found.')
  // Includes archived projects: discovery excludes them, and launching a task in
  // an undiscoverable project would be an inconsistency rather than flexibility.
  if (project.archivedAt !== null) throw notFound('project_not_found', 'Project not found.')
  if (project.ownerId !== userId && project.visibility !== 'shared') {
    throw notFound('project_not_found', 'Project not found.')
  }

  if (!allowsProject(token, projectId)) {
    throw notFound('project_not_found', 'Project not found.')
  }
  return project
}

/** Token allowlist; empty means every project its user can see. */
export function allowsProject(token: ApiTokenRow, projectId: string): boolean {
  const allowed = JSON.parse(token.projectIds) as string[]
  return allowed.length === 0 || allowed.includes(projectId)
}

export function allowedProjectIds(token: ApiTokenRow): string[] {
  return JSON.parse(token.projectIds) as string[]
}

/**
 * A task viewed through a token.
 *
 * Writing remains limited to the conversation owner, as in the interface:
 * shared projects allow multiple readers, not multiple writers.
 *
 * All three rejections return the same code: distinguishing nonexistent IDs
 * from inaccessible ones would reveal database contents to probing callers.
 */
export function loadTaskForToken(
  ctx: AppContext,
  token: ApiTokenRow,
  userId: string,
  taskId: string,
) {
  const conversation = ctx.db
    .select()
    .from(conversations)
    .where(eq(conversations.id, taskId))
    .get()

  if (!conversation || conversation.userId !== userId) {
    throw notFound('task_not_found', 'Task not found.')
  }
  try {
    loadProjectForToken(ctx, token, userId, conversation.projectId)
  } catch {
    throw notFound('task_not_found', 'Task not found.')
  }
  return conversation
}

/** A worktree must belong to the target project and must not have been removed. */
export function assertWorktreeBelongs(
  ctx: AppContext,
  projectId: string,
  worktreeId: string,
): void {
  const row = ctx.db
    .select({ removedAt: worktrees.removedAt })
    .from(worktrees)
    .where(and(eq(worktrees.id, worktreeId), eq(worktrees.projectId, projectId)))
    .get()

  if (!row) throw notFound('worktree_not_found', 'Worktree not found in this project.')
  if (row.removedAt !== null) {
    throw badRequest('worktree_removed', 'This worktree has been removed.')
  }
}

/**
 * Public instance root for links agents pass on to humans.
 *
 * Derived from the request by default because Sillage is reachable through
 * either its domain or local address; fixing either would break the other.
 * However, `Host` is caller-controlled: `server.publicUrl` prevents tokens
 * from manufacturing links to another site when that protection is desired.
 */
export function publicBaseUrl(ctx: AppContext, request: FastifyRequest): string {
  const configured = publicUrlOf(ctx.db, ctx.config)
  if (configured) return configured.replace(/\/+$/, '')

  const host = request.headers.host ?? `localhost:${ctx.config.server.port}`
  return `${request.protocol}://${host}`
}
