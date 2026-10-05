import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { and, count, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { conversations, projects, worktrees, type ProjectRow, type WorktreeRow } from '@sillage/db'
import { createWorktreeBodySchema, type WorktreeDto } from '@sillage/protocol'
import { GitError, addWorktree, readGitStatus, removeWorktree } from '../../git.js'
import type { TerminalManager } from '../../terminals/terminal-manager.js'
import type { AppContext } from '../context.js'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/**
 * Sillage gère les worktrees lui-même plutôt que de déléguer à `claude --worktree` :
 * Codex n'a pas d'équivalent, et il faut de toute façon savoir où ils sont pour les
 * lister et les nettoyer. La gestion est donc identique pour les deux CLI.
 */
export function registerWorktreeRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  terminals: TerminalManager,
): void {
  const loadProject = (projectId: string, userId: string): ProjectRow => {
    const project = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) throw notFound('project_not_found', 'Project not found.')
    if (project.ownerId !== userId && project.visibility !== 'shared') {
      throw notFound('project_not_found', 'Project not found.')
    }
    return project
  }

  const toDto = async (row: typeof worktrees.$inferSelect): Promise<WorktreeDto> => {
    const [usage] = ctx.db
      .select({ total: count() })
      .from(conversations)
      .where(and(eq(conversations.worktreeId, row.id), isNull(conversations.archivedAt)))
      .all()

    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      path: row.path,
      baseRef: row.baseRef,
      createdAt: row.createdAt,
      git: await readGitStatus(row.path),
      conversationCount: usage?.total ?? 0,
    }
  }

  app.get('/api/projects/:id/worktrees', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    loadProject(id, user.id)

    const rows = ctx.db
      .select()
      .from(worktrees)
      .where(and(eq(worktrees.projectId, id), isNull(worktrees.removedAt)))
      .all()

    return Promise.all(rows.map(toDto))
  })

  app.post('/api/projects/:id/worktrees', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = createWorktreeBodySchema.parse(request.body)

    const project = loadProject(id, user.id)
    const row = await createWorktree(ctx, project, user.id, body.name, body.baseRef)

    return reply.status(201).send(await toDto(row))
  })

  app.delete('/api/worktrees/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const force = (request.query as { force?: string }).force === '1'

    const row = ctx.db.select().from(worktrees).where(eq(worktrees.id, id)).get()
    if (!row || row.removedAt) throw notFound('worktree_not_found', 'Worktree not found.')

    const project = loadProject(row.projectId, user.id)
    if (project.ownerId !== user.id) {
      throw forbidden('worktree_delete_forbidden', 'Only the project owner can delete a worktree.')
    }

    // Le travail non commité est perdu à la suppression : on le dit, et on exige une
    // confirmation explicite plutôt que de décider à la place de l'utilisateur.
    const status = await readGitStatus(row.path)
    if (status?.isDirty && !force) {
      throw conflict(
        'worktree_dirty',
        'Worktree {name} has uncommitted changes.',
        { name: row.name },
      )
    }

    // Un shell dont le répertoire va disparaître n'a plus d'objet : on le ferme avant
    // que le dossier parte, plutôt que de le laisser tourner dans un cwd supprimé.
    terminals.closeForCwd(row.path)

    try {
      await removeWorktree(project.workspacePath, row.path, force)
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      // Le dossier a pu disparaître hors de Sillage : on nettoie quand même la trace
      // plutôt que de laisser une entrée fantôme impossible à supprimer.
      await rm(row.path, { recursive: true, force: true }).catch(() => {})
    }

    // Les conversations rattachées passent en lecture seule au lieu d'être effacées :
    // leur historique reste consultable.
    ctx.db.update(worktrees).set({ removedAt: Date.now() }).where(eq(worktrees.id, id)).run()

    return reply.status(204).send()
  })
}

/**
 * Crée un worktree du projet sur une branche, neuve ou existante.
 *
 * Partagé entre la route et les sessions lancées par un agent (`start_session`) : le
 * dossier, la réutilisation d'une branche et la ligne en base suivent la même règle.
 */
export async function createWorktree(
  ctx: AppContext,
  project: ProjectRow,
  userId: string,
  name: string,
  baseRef: string,
): Promise<WorktreeRow> {
  if (!(await readGitStatus(project.workspacePath))) {
    throw badRequest('not_a_repository', 'This project is not a git repository.')
  }

  const existing = ctx.db
    .select()
    .from(worktrees)
    .where(and(eq(worktrees.projectId, project.id), eq(worktrees.name, name)))
    .get()
  if (existing && !existing.removedAt) {
    throw conflict('worktree_exists', 'Worktree {name} already exists.', { name })
  }

  // Les worktrees vivent dans le répertoire de données, pas dans le projet : ils ne
  // doivent pas polluer l'arborescence que l'utilisateur voit dans son éditeur.
  const path = join(ctx.config.paths.worktrees, project.id, name.replace(/\//g, '__'))
  const { reusedBranch } = await addWorktree(project.workspacePath, path, name, baseRef).catch(
    (err: unknown) => {
      if (err instanceof GitError) throw badRequest('git_failed', err.message)
      throw err
    },
  )

  const row: WorktreeRow = {
    id: randomUUID(),
    projectId: project.id,
    name,
    path,
    baseRef: reusedBranch ? name : baseRef,
    createdBy: userId,
    createdAt: Date.now(),
    removedAt: null,
  }

  // Une entrée précédente supprimée porte le même nom : l'index unique l'interdirait.
  if (existing) ctx.db.delete(worktrees).where(eq(worktrees.id, existing.id)).run()
  ctx.db.insert(worktrees).values(row).run()
  return row
}
