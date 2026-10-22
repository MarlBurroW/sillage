import { resolve } from 'node:path'
import { and, asc, count, eq, isNull, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { cards, conversations, projectImages, projectPins, projects, users, writeTransaction } from '@sillage/db'
import {
  createProjectBodySchema,
  createSampleProjectBodySchema,
  MAX_PROJECT_IMAGE_BYTES,
  NO_PROJECT_DEFAULTS,
  parseRemoteUrl,
  readProjectDefaults,
  reorderProjectsBodySchema,
  serializeProjectDefaults,
  startCloneBodySchema,
  updateProjectBodySchema,
  type CardColumn,
  type CloneJobDto,
  type ProjectDto,
} from '@sillage/protocol'
import type { AttachmentStore } from '../../attachments/store.js'
import type { TerminalManager } from '../../terminals/terminal-manager.js'
import type { CloneJobs } from '../../clone-jobs.js'
import { searchFiles } from '../../files.js'
import { credentialEnv, credentialHelperCommand } from '../../git-credential/helper.js'
import { listBranches, readGitStatus } from '../../git.js'
import { dropConversation } from '../../search/search-index.js'
import type { AppContext } from '../context.js'
import { badRequest, forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'
import { projectCwd } from '../../workspace.js'
import { writeProjectsDir } from '../../settings/user-settings.js'
import { createSampleProject } from '../../projects/sample.js'
import {
  projectImageDto,
  readProjectImage,
  sniffProjectImage,
  writeProjectImage,
} from '../../projects/image.js'
import { SkillLibrary } from '../../skill-library/store.js'
import { assertFreeDestination, assertUsableWorkspace, createProject, insertProject } from '../../projects/create.js'

/** Users see projects they own or that are shared. Only owners can edit or delete them. */
export function visibilityFilter(userId: string) {
  return or(eq(projects.ownerId, userId), eq(projects.visibility, 'shared'))
}

/** Project if visible to this user, for routes defined elsewhere. */
export function visibleProject(ctx: AppContext, projectId: string, userId: string) {
  return ctx.db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), visibilityFilter(userId)))
    .get()
}

export function registerProjectRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  attachments: AttachmentStore,
  cloneJobs: CloneJobs,
  terminals: TerminalManager,
): void {
  const loadVisibleProject = async (projectId: string, userId: string) => {
    const row = (
      await ctx.db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), visibilityFilter(userId)))
        .limit(1)
    )[0]
    if (!row) throw notFound('project_not_found', 'Project not found.')
    return row
  }

  app.get('/api/projects', async (request) => {
    const user = requireUser(request)
    const includeArchived = (request.query as { archived?: string }).archived === '1'

    const rows = await ctx.db
      .select({
        project: projects,
        ownerName: users.displayName,
        conversationCount: count(conversations.id),
        // Only timestamp and status: the blob has its own route.
        imageUpdatedAt: projectImages.updatedAt,
        imageProvisional: projectImages.provisional,
        pinnedAt: projectPins.createdAt,
      })
      .from(projects)
      .innerJoin(users, eq(users.id, projects.ownerId))
      .leftJoin(projectImages, eq(projectImages.projectId, projects.id))
      .leftJoin(
        projectPins,
        and(eq(projectPins.projectId, projects.id), eq(projectPins.userId, user.id)),
      )
      .leftJoin(
        conversations,
        and(eq(conversations.projectId, projects.id), isNull(conversations.archivedAt)),
      )
      .where(
        includeArchived
          ? visibilityFilter(user.id)
          : and(visibilityFilter(user.id), isNull(projects.archivedAt)),
      )
      .groupBy(projects.id)
      // Names break position ties: before any reordering all positions are zero,
      // preserving the original alphabetical order.
      .orderBy(asc(projects.position), sql`${projects.name} collate nocase`)

    // Query separately: joining cards alongside conversations would multiply rows
    // and distort conversation counts. One grouped query
    // suffices for all projects.
    const cardCounts = new Map<string, Partial<Record<CardColumn, number>>>()
    for (const entry of await ctx.db
      .select({ projectId: cards.projectId, column: cards.column, total: count() })
      .from(cards)
      .groupBy(cards.projectId, cards.column)) {
      const counts = cardCounts.get(entry.projectId) ?? {}
      counts[entry.column] = entry.total
      cardCounts.set(entry.projectId, counts)
    }

    // Read git statuses concurrently: a slow repository must not serialize the list.
    return Promise.all(
      rows.map(async ({ project, ownerName, conversationCount, ...row }): Promise<ProjectDto> => {
        return {
          id: project.id,
          name: project.name,
          image: projectImageDto(
            project.id,
            row.imageUpdatedAt === null
              ? null
              : { updatedAt: row.imageUpdatedAt, provisional: row.imageProvisional ?? false },
          ),
          workspacePath: project.workspacePath,
          ownerId: project.ownerId,
          ownerName,
          visibility: project.visibility,
          color: project.color,
          isOwner: project.ownerId === user.id,
          position: project.position,
          archivedAt: project.archivedAt,
          createdAt: project.createdAt,
          conversationCount,
          defaultConfig: readProjectDefaults(project.defaultConfig),
          instructionsMode: project.instructionsMode,
          turnCheckpoints: project.turnCheckpoints,
          memoryMode: project.memoryMode,
          activeTerminals: terminals.aliveCount(project.id),
          cardCounts: cardCounts.get(project.id) ?? {},
          pinned: row.pinnedAt !== null,
          git: await readGitStatus(project.workspacePath),
        }
      }),
    )
  })

  app.post('/api/projects', async (request, reply) => {
    const user = requireUser(request)
    const body = createProjectBodySchema.parse(request.body)

    const row = await createProject(ctx, user.id, body)
    if ('parentDir' in body) {
      // Only the interface remembers the directory suggested for the next creation.
      writeProjectsDir(ctx.db, user.id, resolve(body.parentDir))
    }

    const dto: ProjectDto = {
      ...row,
      image: null,
      ownerName: user.displayName,
      isOwner: true,
      conversationCount: 0,
      defaultConfig: NO_PROJECT_DEFAULTS,
      activeTerminals: 0,
      cardCounts: {},
      pinned: false,
      git: await readGitStatus(row.workspacePath),
    }
    return reply.status(201).send(dto)
  })

  /** Tour demo project: Sillage writes a small repository, then creates its project. */
  app.post('/api/projects/sample', async (request, reply) => {
    const user = requireUser(request)
    const body = createSampleProjectBodySchema.parse(request.body)

    const row = await createSampleProject(ctx, user.id, body)
    writeProjectsDir(ctx.db, user.id, resolve(body.parentDir))

    const dto: ProjectDto = {
      ...row,
      image: null,
      ownerName: user.displayName,
      isOwner: true,
      conversationCount: 0,
      defaultConfig: NO_PROJECT_DEFAULTS,
      activeTerminals: 0,
      cardCounts: {},
      pinned: false,
      git: await readGitStatus(row.workspacePath),
    }
    return reply.status(201).send(dto)
  })

  /** Starts a clone and returns its tracking ID. Create the project only on success: a row pointing to a half-cloned directory offers nothing and would require manual deletion. Return 202 rather than 201 because large repositories take minutes, longer than an HTTP request can stay open. */
  app.post('/api/projects/clone', async (request, reply): Promise<CloneJobDto> => {
    const user = requireUser(request)
    const body = startCloneBodySchema.parse(request.body)

    const remote = parseRemoteUrl(body.url)
    if (!remote) {
      throw badRequest(
        'clone_url_invalid',
        'Expected a repository URL such as https://github.com/owner/repo.git.',
      )
    }
    const destination = await assertFreeDestination(body.parentDir, body.directory)
    // Remember the parent directory just as for projects created from scratch.
    writeProjectsDir(ctx.db, user.id, resolve(body.parentDir))

    const job = cloneJobs.start({
      ownerId: user.id,
      // Use the normalized form rather than raw input: git would fail on a URL query
      // copied from a browser.
      url: remote.url,
      destination,
      env: credentialEnv(ctx.config.paths, user.id),
      helper: credentialHelperCommand(ctx.config.paths, user.id),
      createProject: async () => {
        const row = await insertProject(ctx, user.id, {
          name: body.name,
          workspacePath: destination,
          visibility: body.visibility,
          color: body.color,
          instructionsMode: body.instructionsMode,
        })
        return row.id
      },
    })

    return reply.status(202).send(job)
  })

  /** Clone state polled until completion. State does not survive server restarts, which kill git anyway; unknown identifiers therefore mean the clone was lost. */
  app.get('/api/projects/clone/:id', async (request): Promise<CloneJobDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    const job = cloneJobs.get(id, user.id)
    if (!job) throw notFound('clone_not_found', 'Unknown or expired clone.')
    return job
  })

  /** Manual project order. Clients send the entire displayed list; rewriting positions together avoids gaps and ties from individual moves. Positions belong to projects, like conversation positions: accounts viewing the same shared project also share its rank. */
  app.post('/api/projects/order', async (request) => {
    const user = requireUser(request)
    const body = reorderProjectsBodySchema.parse(request.body)

    const visible = new Set(
      ctx.db
        .select({ id: projects.id })
        .from(projects)
        .where(visibilityFilter(user.id))
        .all()
        .map((row) => row.id),
    )
    // An invisible project in the list would reorder something the user cannot see:
    // reject the entire request rather than apply a partial order.
    const intruder = body.ids.find((id) => !visible.has(id))
    if (intruder) throw notFound('project_not_found', 'Project not found.')

    writeTransaction(ctx.db, (tx) => {
      body.ids.forEach((id, index) => {
        tx.update(projects).set({ position: index }).where(eq(projects.id, id)).run()
      })
    })

    return { ok: true }
  })

  app.patch('/api/projects/:id', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = updateProjectBodySchema.parse(request.body)

    const project = await loadVisibleProject(id, user.id)
    if (project.ownerId !== user.id) {
      throw forbidden('project_edit_forbidden', 'Only the owner can modify this project.')
    }

    const patch: Partial<typeof projects.$inferInsert> = {}
    if (body.name !== undefined) patch.name = body.name
    if (body.workspacePath !== undefined) {
      // Running runners retain their cwd until their next start:
      // CLI working directories are fixed at launch.
      patch.workspacePath = await assertUsableWorkspace(body.workspacePath)
    }
    if (body.visibility !== undefined) patch.visibility = body.visibility
    if (body.color !== undefined) patch.color = body.color
    if (body.defaultConfig !== undefined) {
      // Read and rewrite the whole value: the screen edits one CLI at a time, and writing
      // both would overwrite a preset another tab may have just saved.
      const current = readProjectDefaults(project.defaultConfig)
      patch.defaultConfig = serializeProjectDefaults({
        ...current,
        [body.defaultConfig.agent]: body.defaultConfig.config,
      })
    }
    if (body.archived !== undefined) patch.archivedAt = body.archived ? Date.now() : null
    if (body.turnCheckpoints !== undefined) patch.turnCheckpoints = body.turnCheckpoints
    // Applied on the next runner launch; running sessions retain their memory.
    if (body.memoryMode !== undefined) patch.memoryMode = body.memoryMode

    if (Object.keys(patch).length > 0) {
      await ctx.db.update(projects).set(patch).where(eq(projects.id, id))
    }
    return { ok: true }
  })

  app.delete('/api/projects/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    const project = await loadVisibleProject(id, user.id)
    if (project.ownerId !== user.id) {
      throw forbidden('project_delete_forbidden', 'Only the owner can delete this project.')
    }

    // Project conversations cascade on deletion, as do their attachments:
    // remove their disk files first.
    const owned = ctx.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.projectId, id))
      .all()
    await attachments.removeForConversations(owned.map((row) => row.id))
    const tickets = ctx.db.select({ id: cards.id }).from(cards).where(eq(cards.projectId, id)).all()
    await attachments.removeForCards(tickets.map((row) => row.id))
    // The same applies to the search index, which SQL cascades cannot reach.
    for (const row of owned) dropConversation(ctx.db, row.id)

    // Never touch the disk workspace: Sillage references it but does not own it.
    // Project shells run on its behalf, however, and must be closed.
    terminals.closeForProject(id)
    // Project skills do belong to Sillage. Remove them before the cascade deletes
    // the rows needed to locate disabled skills.
    new SkillLibrary(ctx.db, ctx.config.paths.skillLibrary).removeProject(id)
    await ctx.db.delete(projects).where(eq(projects.id, id))
    return reply.status(204).send()
  })

  /** Project image, readable by anyone who can see the project, like its name. Client URLs include the image timestamp, giving every version a distinct URL and allowing immutable caching. */
  /** Pins or unpins the project for the caller. Any project viewer may do this: pinning does not modify the project. Both operations are idempotent, like conversation bookmarks, so clients need not know the previous state. */
  app.put('/api/projects/:id/pin', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    await loadVisibleProject(id, user.id)

    ctx.db
      .insert(projectPins)
      .values({ projectId: id, userId: user.id, createdAt: Date.now() })
      .onConflictDoNothing()
      .run()

    return { pinned: true }
  })

  app.delete('/api/projects/:id/pin', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    await loadVisibleProject(id, user.id)

    ctx.db
      .delete(projectPins)
      .where(and(eq(projectPins.projectId, id), eq(projectPins.userId, user.id)))
      .run()

    return { pinned: false }
  })

  app.get('/api/projects/:id/image', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    await loadVisibleProject(id, user.id)

    const image = readProjectImage(ctx.db, id)
    if (!image) throw notFound('project_image_not_found', 'This project has no image.')

    return (
      reply
        .type(image.mimeType)
        .header('x-content-type-options', 'nosniff')
        // SVGs opened in their own tabs are documents including scripts, sometimes from
        // cloned repositories: sandboxing reduces them to images.
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .header('cache-control', 'private, max-age=31536000, immutable')
        .send(image.data)
    )
  })

  /** An image chosen by a person is never provisional. */
  app.put('/api/projects/:id/image', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const project = await loadVisibleProject(id, user.id)
    if (project.ownerId !== user.id) {
      throw forbidden('project_edit_forbidden', 'Only the owner can modify this project.')
    }

    const file = await request.file({ limits: { fileSize: MAX_PROJECT_IMAGE_BYTES } })
    if (!file) throw badRequest('no_file', 'No file received.')
    // `toBuffer` fails on exceeding the limit, as with attachments.
    const data = await file.toBuffer().catch(() => null)
    if (!data) {
      throw badRequest('project_image_too_large', 'Image is too large (maximum {maxKb} KB).', {
        maxKb: Math.round(MAX_PROJECT_IMAGE_BYTES / 1024),
      })
    }

    const mimeType = sniffProjectImage(data)
    if (!mimeType) {
      throw badRequest(
        'project_image_invalid',
        'Expected a PNG, JPEG, GIF, WebP or SVG image.',
      )
    }

    const image = writeProjectImage(ctx.db, id, { mimeType, data, provisional: false })
    return { image: projectImageDto(id, image) }
  })

  app.delete('/api/projects/:id/image', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const project = await loadVisibleProject(id, user.id)
    if (project.ownerId !== user.id) {
      throw forbidden('project_edit_forbidden', 'Only the owner can modify this project.')
    }

    await ctx.db.delete(projectImages).where(eq(projectImages.projectId, id))
    return reply.status(204).send()
  })

  /** Working-directory files for mention completion. Project-scoped because the composer offers mentions before a conversation exists. Choosing a worktree changes the directory queried. */
  app.get('/api/projects/:id/files', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { q, worktreeId } = request.query as { q?: string; worktreeId?: string }
    const cwd = projectCwd(ctx.db, id, user.id, worktreeId)

    return { files: await searchFiles(cwd, q ?? '') }
  })

  app.get('/api/projects/:id/branches', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const project = await loadVisibleProject(id, user.id)

    const git = await readGitStatus(project.workspacePath)
    if (!git) return { branches: [], current: null }

    return { branches: await listBranches(project.workspacePath), current: git.branch }
  })
}
