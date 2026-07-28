import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { and, count, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { conversations, projects, worktrees, type ProjectRow } from '@sillage/db'
import { createWorktreeBodySchema, type WorktreeDto } from '@sillage/protocol'
import { GitError, addWorktree, readGitStatus, removeWorktree } from '../../git.js'
import type { AppContext } from '../context.js'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/**
 * Sillage gère les worktrees lui-même plutôt que de déléguer à `claude --worktree` :
 * Codex n'a pas d'équivalent, et il faut de toute façon savoir où ils sont pour les
 * lister et les nettoyer. La gestion est donc identique pour les deux CLI.
 */
export function registerWorktreeRoutes(app: FastifyInstance, ctx: AppContext): void {
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
    if (!(await readGitStatus(project.workspacePath))) {
      throw badRequest('not_a_repository', 'This project is not a git repository.')
    }

    const existing = ctx.db
      .select()
      .from(worktrees)
      .where(and(eq(worktrees.projectId, id), eq(worktrees.name, body.name)))
      .get()
    if (existing && !existing.removedAt) {
      throw conflict('worktree_exists', 'Worktree {name} already exists.', { name: body.name })
    }

    // Les worktrees vivent dans le répertoire de données, pas dans le projet : ils ne
    // doivent pas polluer l'arborescence que l'utilisateur voit dans son éditeur.
    const path = join(ctx.config.paths.worktrees, id, body.name.replace(/\//g, '__'))
    const { reusedBranch } = await addWorktree(
      project.workspacePath,
      path,
      body.name,
      body.baseRef,
    ).catch((err: unknown) => {
      if (err instanceof GitError) throw badRequest('git_failed', err.message)
      throw err
    })

    const row = {
      id: randomUUID(),
      projectId: id,
      name: body.name,
      path,
      baseRef: reusedBranch ? body.name : body.baseRef,
      createdBy: user.id,
      createdAt: Date.now(),
      removedAt: null,
    }

    // Une entrée précédente supprimée porte le même nom : l'index unique l'interdirait.
    if (existing) ctx.db.delete(worktrees).where(eq(worktrees.id, existing.id)).run()
    ctx.db.insert(worktrees).values(row).run()

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
