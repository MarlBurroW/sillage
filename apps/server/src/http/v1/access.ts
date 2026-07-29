import { and, eq } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import { conversations, projects, worktrees, type ApiTokenRow, type ProjectRow } from '@sillage/db'
import type { AppContext } from '../context.js'
import { badRequest, notFound } from '../errors.js'

/**
 * Ce qu'un jeton peut atteindre.
 *
 * Deux filtres se composent, et jamais un seul : ce que son utilisateur voit déjà, et
 * la liste de projets que le jeton déclare. Un jeton emprunte une identité, il ne
 * l'élargit pas ; et restreindre ses projets est le vrai garde-fou quand il part chez
 * un tiers.
 */
export function loadProjectForToken(
  ctx: AppContext,
  token: ApiTokenRow,
  userId: string,
  projectId: string,
): ProjectRow {
  const project = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project) throw notFound('project_not_found', 'Project not found.')
  // Archivé compris : la route de découverte ne le liste pas, et pouvoir lancer une
  // tâche sur un projet qu'on ne peut pas trouver est une incohérence, pas une souplesse.
  if (project.archivedAt !== null) throw notFound('project_not_found', 'Project not found.')
  if (project.ownerId !== userId && project.visibility !== 'shared') {
    throw notFound('project_not_found', 'Project not found.')
  }

  if (!allowsProject(token, projectId)) {
    throw notFound('project_not_found', 'Project not found.')
  }
  return project
}

/** Liste blanche du jeton ; vide signifie « tous ceux que son utilisateur voit ». */
export function allowsProject(token: ApiTokenRow, projectId: string): boolean {
  const allowed = JSON.parse(token.projectIds) as string[]
  return allowed.length === 0 || allowed.includes(projectId)
}

export function allowedProjectIds(token: ApiTokenRow): string[] {
  return JSON.parse(token.projectIds) as string[]
}

/**
 * Une tâche, vue par le jeton.
 *
 * L'écriture reste réservée au propriétaire du fil, comme dans l'interface : un projet
 * partagé se lit à plusieurs mais ne s'écrit pas à plusieurs.
 *
 * Les trois refus rendent le même code : distinguer « cet identifiant n'existe pas » de
 * « il existe mais pas pour toi » apprendrait à un appelant qui tâtonne ce que la base
 * contient.
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

/** Un worktree doit appartenir au projet visé, et ne pas avoir été retiré. */
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
 * Racine publique de l'instance, pour le lien qu'un agent fera suivre à un humain.
 *
 * Déduite de la requête par défaut, parce que Sillage s'atteint aussi bien par son nom
 * de domaine que par son adresse locale et que figer l'un rendrait l'autre inutilisable.
 * Mais l'en-tête `Host` vient de l'appelant : `server.publicUrl` existe pour qui ne veut
 * pas qu'un jeton puisse fabriquer un lien vers un autre site.
 */
export function publicBaseUrl(ctx: AppContext, request: FastifyRequest): string {
  const configured = ctx.config.server.publicUrl
  if (configured) return configured.replace(/\/+$/, '')

  const host = request.headers.host ?? `localhost:${ctx.config.server.port}`
  return `${request.protocol}://${host}`
}
