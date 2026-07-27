import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { and, asc, count, eq, isNull, max, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { conversations, projects, users, worktrees } from '@sillage/db'
import {
  createProjectBodySchema,
  reorderProjectsBodySchema,
  updateProjectBodySchema,
  type ProjectDto,
} from '@sillage/protocol'
import type { AttachmentStore } from '../../attachments/store.js'
import { searchFiles } from '../../files.js'
import { listBranches, readGitStatus } from '../../git.js'
import { dropConversation } from '../../search/search-index.js'
import type { AppContext } from '../context.js'
import { badRequest, forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/**
 * Un utilisateur voit un projet s'il en est propriétaire ou si le projet est partagé.
 * Seul le propriétaire peut le modifier ou le supprimer.
 */
function visibilityFilter(userId: string) {
  return or(eq(projects.ownerId, userId), eq(projects.visibility, 'shared'))
}

async function assertUsableWorkspace(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw badRequest('workspace_not_absolute', 'Le chemin du workspace doit être absolu.')
  }

  const resolved = resolve(path)
  let info
  try {
    info = await stat(resolved)
  } catch {
    throw badRequest('workspace_missing', `Le dossier ${resolved} n'existe pas.`)
  }

  if (!info.isDirectory()) {
    throw badRequest('workspace_not_a_directory', `${resolved} n'est pas un dossier.`)
  }

  return resolved
}

export function registerProjectRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  attachments: AttachmentStore,
): void {
  const loadVisibleProject = async (projectId: string, userId: string) => {
    const row = (
      await ctx.db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), visibilityFilter(userId)))
        .limit(1)
    )[0]
    if (!row) throw notFound('Projet introuvable.')
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
      })
      .from(projects)
      .innerJoin(users, eq(users.id, projects.ownerId))
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
      // Le nom départage les positions égales : tant que rien n'a été déplacé, tous
      // les projets sont à zéro et la liste garde son ordre alphabétique d'origine.
      .orderBy(asc(projects.position), sql`${projects.name} collate nocase`)

    // Les statuts git sont lus en parallèle : un dépôt lent ne doit pas sérialiser la liste.
    return Promise.all(
      rows.map(async ({ project, ownerName, conversationCount }): Promise<ProjectDto> => {
        return {
          id: project.id,
          name: project.name,
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
          git: await readGitStatus(project.workspacePath),
        }
      }),
    )
  })

  app.post('/api/projects', async (request, reply) => {
    const user = requireUser(request)
    const body = createProjectBodySchema.parse(request.body)
    const workspacePath = await assertUsableWorkspace(body.workspacePath)

    // En fin de liste : s'insérer au milieu déplacerait visuellement des projets que
    // l'utilisateur avait rangés lui-même.
    const [highest] = await ctx.db.select({ max: max(projects.position) }).from(projects)

    const row = {
      id: randomUUID(),
      name: body.name,
      workspacePath,
      ownerId: user.id,
      visibility: body.visibility,
      color: body.color,
      defaultConfig: null,
      position: (highest?.max ?? 0) + 1,
      archivedAt: null,
      createdAt: Date.now(),
    }
    await ctx.db.insert(projects).values(row)

    const dto: ProjectDto = {
      ...row,
      ownerName: user.displayName,
      isOwner: true,
      conversationCount: 0,
      git: await readGitStatus(workspacePath),
    }
    return reply.status(201).send(dto)
  })

  /**
   * Ordre manuel des projets. Le client envoie la liste complète telle qu'elle
   * s'affiche : réécrire les positions en bloc évite les trous et les égalités qu'un
   * déplacement unitaire finirait par produire.
   *
   * La position vit sur le projet, comme celle des conversations : deux comptes qui
   * voient un même projet partagé partagent aussi son rang.
   */
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
    // Un projet invisible dans la liste reclasserait quelque chose que l'utilisateur
    // n'a pas le droit de voir : on refuse l'ensemble plutôt qu'un ordre partiel.
    const intruder = body.ids.find((id) => !visible.has(id))
    if (intruder) throw notFound('Projet introuvable.')

    ctx.db.transaction((tx) => {
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
      throw forbidden('Seul le propriétaire peut modifier ce projet.')
    }

    const patch: Partial<typeof projects.$inferInsert> = {}
    if (body.name !== undefined) patch.name = body.name
    if (body.workspacePath !== undefined) {
      // Les runners déjà lancés gardent leur cwd jusqu'à leur prochain démarrage :
      // le répertoire de travail d'un CLI est fixé au lancement.
      patch.workspacePath = await assertUsableWorkspace(body.workspacePath)
    }
    if (body.visibility !== undefined) patch.visibility = body.visibility
    if (body.color !== undefined) patch.color = body.color
    if (body.defaultConfig !== undefined) {
      patch.defaultConfig = body.defaultConfig ? JSON.stringify(body.defaultConfig) : null
    }
    if (body.archived !== undefined) patch.archivedAt = body.archived ? Date.now() : null

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
      throw forbidden('Seul le propriétaire peut supprimer ce projet.')
    }

    // Les conversations du projet partent en cascade, donc leurs pièces jointes
    // aussi : leurs fichiers doivent être retirés du disque avant.
    const owned = ctx.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.projectId, id))
      .all()
    await attachments.removeForConversations(owned.map((row) => row.id))
    // Même raison pour l'index de recherche, que la cascade SQL n'atteint pas.
    for (const row of owned) dropConversation(ctx.db, row.id)

    // Le workspace sur disque n'est jamais touché : Sillage pointe dessus, ne le possède pas.
    await ctx.db.delete(projects).where(eq(projects.id, id))
    return reply.status(204).send()
  })

  /**
   * Fichiers du répertoire de travail, pour l'autocomplétion des mentions.
   *
   * Portée par le projet plutôt que par la conversation : la barre de saisie propose
   * déjà des mentions avant qu'une conversation existe. Le worktree, quand il est
   * choisi, change le dossier consulté.
   */
  app.get('/api/projects/:id/files', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { q, worktreeId } = request.query as { q?: string; worktreeId?: string }
    const project = await loadVisibleProject(id, user.id)

    let cwd = project.workspacePath
    if (worktreeId) {
      const worktree = ctx.db.select().from(worktrees).where(eq(worktrees.id, worktreeId)).get()
      if (!worktree || worktree.projectId !== id) throw notFound('Worktree introuvable.')
      if (!worktree.removedAt) cwd = worktree.path
    }

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
