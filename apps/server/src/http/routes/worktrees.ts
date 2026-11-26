import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { and, count, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { conversations, projects, worktreeKeptFiles, worktrees, type ProjectRow, type WorktreeRow } from '@sillage/db'
import {
  createWorktreeBodySchema,
  worktreeBulkCleanupBodySchema,
  worktreeCleanupBodySchema,
  worktreeKeepBodySchema,
  type WorktreeCleanupPlanDto,
  type WorktreeBulkCleanupResultDto,
  type WorktreeCleanupResultDto,
  type WorktreeDto,
  type WorktreeStatusListDto,
} from '@sillage/protocol'
import { GitError, addWorktree, readGitStatus } from '../../git.js'
import type { WorktreeCleanup } from '../../worktrees/cleanup.js'
import type { WorktreeStatusService } from '../../worktrees/status-service.js'
import type { AppContext } from '../context.js'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/** Sillage manages worktrees instead of delegating to `claude --worktree`: Codex has no equivalent, and listing and cleaning them requires knowing their locations anyway. Management is therefore identical for both CLIs. */
export function registerWorktreeRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  worktreeStatus: WorktreeStatusService,
  cleanup: WorktreeCleanup,
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

  /** Project worktrees known to git or the database, assessed against the default branch with their attached conversations. Served from the service cache, which never blocks on large repositories (see its implementation). */
  app.get('/api/projects/:id/worktrees/status', async (request): Promise<WorktreeStatusListDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const project = loadProject(id, user.id)
    if (!(await readGitStatus(project.workspacePath))) {
      return { base: null, computedAt: Date.now(), fresh: true, worktrees: [] }
    }
    return worktreeStatus.get(project)
  })

  /** Previews what 'Clean up' would do for confirmation. Returns 404 when the path is not a project worktree. */
  app.get('/api/projects/:id/worktrees/cleanup', async (request): Promise<WorktreeCleanupPlanDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { path } = request.query as { path?: string }
    const project = loadProject(id, user.id)
    if (project.ownerId !== user.id) throw forbidden('worktree_delete_forbidden', 'Only the project owner can clean a worktree.')
    const plan = path ? await cleanup.plan(project, path) : null
    if (!plan) throw notFound('worktree_not_found', 'Worktree not found.')
    return plan
  })

  app.post('/api/projects/:id/worktrees/cleanup', async (request): Promise<WorktreeCleanupResultDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = worktreeCleanupBodySchema.parse(request.body)
    const project = loadProject(id, user.id)
    if (project.ownerId !== user.id) throw forbidden('worktree_delete_forbidden', 'Only the project owner can clean a worktree.')
    const result = await cleanup.run(project, body)
    if (!result) throw notFound('worktree_not_found', 'Worktree not found.')
    return result
  })

  /** Cleans up several trees with nothing left to lose; the client sends long selections in slices. */
  app.post('/api/projects/:id/worktrees/cleanup/bulk', async (request): Promise<WorktreeBulkCleanupResultDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = worktreeBulkCleanupBodySchema.parse(request.body)
    const project = loadProject(id, user.id)
    if (project.ownerId !== user.id) throw forbidden('worktree_delete_forbidden', 'Only the project owner can clean a worktree.')
    return cleanup.runMany(project, body)
  })

  /** Keeps the files left in a merged tree, exactly those the user saw: a fingerprint computed since then means something changed, and keeping it would hide work never reviewed. */
  app.post('/api/projects/:id/worktrees/keep', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = worktreeKeepBodySchema.parse(request.body)
    const project = loadProject(id, user.id)
    if (project.ownerId !== user.id) throw forbidden('worktree_keep_forbidden', 'Only the project owner can keep worktree files.')
    const tree = (await worktreeStatus.fresh(project)).worktrees.find((entry) => entry.path === body.path)
    if (!tree) throw notFound('worktree_not_found', 'Worktree not found.')
    if (tree.state !== 'leftovers' || tree.fingerprint !== body.fingerprint) {
      throw conflict('worktree_leftovers_changed', 'The files left in this worktree have changed. Review them again.')
    }
    const row = {
      projectId: project.id,
      path: tree.path,
      fingerprint: body.fingerprint,
      files: tree.modified + tree.untracked,
      keptBy: user.id,
      keptAt: Date.now(),
    }
    ctx.db
      .insert(worktreeKeptFiles)
      .values(row)
      .onConflictDoUpdate({ target: [worktreeKeptFiles.projectId, worktreeKeptFiles.path], set: row })
      .run()
    worktreeStatus.forget(project.id)
    return reply.status(204).send()
  })

  app.delete('/api/projects/:id/worktrees/keep', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { path } = request.query as { path?: string }
    const project = loadProject(id, user.id)
    if (project.ownerId !== user.id) throw forbidden('worktree_keep_forbidden', 'Only the project owner can keep worktree files.')
    if (!path) throw badRequest('worktree_path_required', 'Worktree path required.')
    ctx.db
      .delete(worktreeKeptFiles)
      .where(and(eq(worktreeKeptFiles.projectId, project.id), eq(worktreeKeptFiles.path, path)))
      .run()
    worktreeStatus.forget(project.id)
    return reply.status(204).send()
  })

  app.post('/api/projects/:id/worktrees', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = createWorktreeBodySchema.parse(request.body)

    const project = loadProject(id, user.id)
    const row = await createWorktree(ctx, project, user.id, body.name, body.baseRef)
    worktreeStatus.forget(project.id)

    return reply.status(201).send(await toDto(row))
  })
}

/** Creates a project worktree on a new or existing branch. Shared by the route and agent-launched sessions (`start_session`) so directory selection, branch reuse and database records follow the same rules. */
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
    .where(and(eq(worktrees.projectId, project.id), eq(worktrees.name, name), isNull(worktrees.removedAt)))
    .get()
  if (existing) {
    throw conflict('worktree_exists', 'Worktree {name} already exists.', { name })
  }

  // Worktrees live in the data directory, outside projects:
  // they must not clutter the tree users see in their editor.
  const path = join(ctx.config.paths.worktrees, project.id, name.replace(/\//g, '__'))
  const row: WorktreeRow = {
    id: randomUUID(),
    projectId: project.id,
    name,
    path,
    baseRef,
    createdBy: userId,
    createdAt: Date.now(),
    removedAt: null,
  }

  // Claim the name in the database first, then let git create the tree: the other order left a
  // directory and a branch behind whenever the insert failed, and every retry then stopped on
  // "already exists". A removed entry of the same name stays (the index covers live trees only).
  try {
    ctx.db.insert(worktrees).values(row).run()
  } catch (err) {
    if (/UNIQUE constraint failed/.test(err instanceof Error ? err.message : '')) {
      throw conflict('worktree_exists', 'Worktree {name} already exists.', { name })
    }
    throw err
  }
  try {
    const { reusedBranch } = await addWorktree(project.workspacePath, path, name, baseRef)
    if (reusedBranch) {
      row.baseRef = name
      ctx.db.update(worktrees).set({ baseRef: name }).where(eq(worktrees.id, row.id)).run()
    }
  } catch (err) {
    ctx.db.delete(worktrees).where(eq(worktrees.id, row.id)).run()
    if (err instanceof GitError) throw badRequest('git_failed', err.message)
    throw err
  }
  return row
}
