import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { and, asc, count, eq, isNull, max, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { conversations, projects, users, writeTransaction } from '@sillage/db'
import {
  createProjectBodySchema,
  parseRemoteUrl,
  reorderProjectsBodySchema,
  startCloneBodySchema,
  updateProjectBodySchema,
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
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'
import { projectCwd } from '../../workspace.js'

/**
 * Un utilisateur voit un projet s'il en est propriétaire ou si le projet est partagé.
 * Seul le propriétaire peut le modifier ou le supprimer.
 */
function visibilityFilter(userId: string) {
  return or(eq(projects.ownerId, userId), eq(projects.visibility, 'shared'))
}

/** Le projet, s'il est visible par cet utilisateur. Pour les routes hébergées ailleurs. */
export function visibleProject(ctx: AppContext, projectId: string, userId: string) {
  return ctx.db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), visibilityFilter(userId)))
    .get()
}

async function assertUsableWorkspace(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw badRequest('workspace_not_absolute', 'The workspace path must be absolute.')
  }

  const resolved = resolve(path)
  let info
  try {
    info = await stat(resolved)
  } catch {
    throw badRequest('workspace_missing', 'Directory {path} does not exist.', { path: resolved })
  }

  if (!info.isDirectory()) {
    throw badRequest('workspace_not_a_directory', '{path} is not a directory.', { path: resolved })
  }

  return resolved
}

/**
 * Le dossier que le clone va remplir.
 *
 * Symétrique de `assertUsableWorkspace` : là où un projet ordinaire exige un dossier qui
 * existe, un clone exige un emplacement libre. Un dossier existant mais vide est accepté,
 * parce que c'est ce que produit un `mkdir` fait d'avance par l'utilisateur.
 */
async function assertFreeDestination(parentDir: string, directory: string): Promise<string> {
  if (!isAbsolute(parentDir)) {
    throw badRequest('workspace_not_absolute', 'The workspace path must be absolute.')
  }
  // Le nom de dossier vient d'une URL de dépôt : sans cette garde, `..` ferait écrire
  // le clone n'importe où sur le disque.
  if (directory.includes('/') || directory.includes('\\') || directory.startsWith('.')) {
    throw badRequest('clone_directory_invalid', 'The directory name must be a plain folder name.')
  }

  const parent = resolve(parentDir)
  const info = await stat(parent).catch(() => null)
  if (!info) {
    throw badRequest('workspace_missing', 'Directory {path} does not exist.', { path: parent })
  }
  if (!info.isDirectory()) {
    throw badRequest('workspace_not_a_directory', '{path} is not a directory.', { path: parent })
  }

  const destination = join(parent, directory)
  const existing = await readdir(destination).catch(() => null)
  if (existing && existing.length > 0) {
    throw conflict(
      'clone_destination_not_empty',
      'Directory {path} already exists and is not empty.',
      { path: destination },
    )
  }

  return destination
}

export function registerProjectRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  attachments: AttachmentStore,
  cloneJobs: CloneJobs,
  terminals: TerminalManager,
): void {
  /**
   * En fin de liste : s'insérer au milieu déplacerait visuellement des projets que
   * l'utilisateur avait rangés lui-même.
   */
  const insertProject = async (
    ownerId: string,
    fields: {
      name: string
      workspacePath: string
      visibility: 'private' | 'shared'
      color: string | null
    },
  ) => {
    const [highest] = await ctx.db.select({ max: max(projects.position) }).from(projects)

    const row = {
      id: randomUUID(),
      ...fields,
      ownerId,
      defaultConfig: null,
      position: (highest?.max ?? 0) + 1,
      archivedAt: null,
      createdAt: Date.now(),
    }
    await ctx.db.insert(projects).values(row)
    return row
  }

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
          activeTerminals: terminals.aliveCount(project.id),
          git: await readGitStatus(project.workspacePath),
        }
      }),
    )
  })

  app.post('/api/projects', async (request, reply) => {
    const user = requireUser(request)
    const body = createProjectBodySchema.parse(request.body)
    const workspacePath = await assertUsableWorkspace(body.workspacePath)

    const row = await insertProject(user.id, {
      name: body.name,
      workspacePath,
      visibility: body.visibility,
      color: body.color,
    })

    const dto: ProjectDto = {
      ...row,
      ownerName: user.displayName,
      isOwner: true,
      conversationCount: 0,
      activeTerminals: 0,
      git: await readGitStatus(workspacePath),
    }
    return reply.status(201).send(dto)
  })

  /**
   * Lance un clone et rend son identifiant de suivi.
   *
   * Le projet n'est créé qu'à la réussite : une ligne pointant sur un dossier à demi
   * cloné n'aurait rien à offrir, et il faudrait la supprimer à la main.
   *
   * 202 et non 201 : un gros dépôt met plusieurs minutes, bien au-delà de ce qu'une
   * requête HTTP peut tenir ouvert.
   */
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

    const job = cloneJobs.start({
      ownerId: user.id,
      // La forme normalisée, pas la saisie : git échouerait sur la requête d'une adresse
      // copiée depuis un navigateur.
      url: remote.url,
      destination,
      env: credentialEnv(ctx.config.paths, user.id),
      helper: credentialHelperCommand(ctx.config.paths, user.id),
      createProject: async () => {
        const row = await insertProject(user.id, {
          name: body.name,
          workspacePath: destination,
          visibility: body.visibility,
          color: body.color,
        })
        return row.id
      },
    })

    return reply.status(202).send(job)
  })

  /**
   * État d'un clone, interrogé par le client jusqu'à ce qu'il aboutisse.
   *
   * Les états ne survivent pas au redémarrage du serveur, qui aurait de toute façon tué
   * le process git : un identifiant inconnu vaut donc « clone perdu ».
   */
  app.get('/api/projects/clone/:id', async (request): Promise<CloneJobDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    const job = cloneJobs.get(id, user.id)
    if (!job) throw notFound('clone_not_found', 'Unknown or expired clone.')
    return job
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
      throw forbidden('project_delete_forbidden', 'Only the owner can delete this project.')
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

    // Le workspace sur disque n'est jamais touché : Sillage pointe dessus, ne le possède
    // pas. Les shells du projet, en revanche, tournent en son nom : on les ferme.
    terminals.closeForProject(id)
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
