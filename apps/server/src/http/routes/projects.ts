import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { and, asc, count, eq, isNull, max, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { cards, conversations, projectImages, projectPins, projects, users, writeTransaction } from '@sillage/db'
import {
  createProjectBodySchema,
  MAX_PROJECT_IMAGE_BYTES,
  NO_PROJECT_DEFAULTS,
  parseRemoteUrl,
  readProjectDefaults,
  reorderProjectsBodySchema,
  serializeProjectDefaults,
  startCloneBodySchema,
  updateProjectBodySchema,
  type CloneJobDto,
  type InstructionsMode,
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
import { writeProjectsDir } from '../../settings/user-settings.js'
import {
  projectImageDto,
  readProjectImage,
  sniffProjectImage,
  writeProjectImage,
} from '../../projects/image.js'
import { SkillLibrary } from '../../skill-library/store.js'
import { repoInstructionFiles } from '../../instructions/store.js'

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
      instructionsMode: InstructionsMode | undefined
    },
  ) => {
    const [highest] = await ctx.db.select({ max: max(projects.position) }).from(projects)

    const row = {
      id: randomUUID(),
      ...fields,
      // Fixé dès la création, faute de choix d'après ce que le dossier porte déjà : un
      // mode résolu à chaque lancement basculerait le jour où un agent crée un AGENTS.md.
      instructionsMode:
        fields.instructionsMode ??
        (repoInstructionFiles(fields.workspacePath).length > 0 ? 'repo' : 'sillage'),
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
        // Sa date et son statut seulement : le blob ne sort que par sa propre route.
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
      // Le nom départage les positions égales : tant que rien n'a été déplacé, tous
      // les projets sont à zéro et la liste garde son ordre alphabétique d'origine.
      .orderBy(asc(projects.position), sql`${projects.name} collate nocase`)

    // Les statuts git sont lus en parallèle : un dépôt lent ne doit pas sérialiser la liste.
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
          activeTerminals: terminals.aliveCount(project.id),
          pinned: row.pinnedAt !== null,
          git: await readGitStatus(project.workspacePath),
        }
      }),
    )
  })

  app.post('/api/projects', async (request, reply) => {
    const user = requireUser(request)
    const body = createProjectBodySchema.parse(request.body)

    let workspacePath: string
    if ('workspacePath' in body) {
      workspacePath = await assertUsableWorkspace(body.workspacePath)
    } else {
      // Un projet qui part de zéro : le dossier est créé ici, dans le parent choisi.
      // Un dossier déjà là mais vide passe aussi, comme pour un clone.
      workspacePath = await assertFreeDestination(body.parentDir, body.directory)
      await mkdir(workspacePath, { recursive: true })
      // Le parent devient la proposition de la prochaine création : c'est là que
      // cette personne range ses projets, inutile de le lui redemander.
      writeProjectsDir(ctx.db, user.id, resolve(body.parentDir))
    }

    const row = await insertProject(user.id, {
      name: body.name,
      workspacePath,
      visibility: body.visibility,
      color: body.color,
      instructionsMode: body.instructionsMode,
    })

    const dto: ProjectDto = {
      ...row,
      image: null,
      ownerName: user.displayName,
      isOwner: true,
      conversationCount: 0,
      defaultConfig: NO_PROJECT_DEFAULTS,
      activeTerminals: 0,
      pinned: false,
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
    // Même mémoire que pour un projet créé de zéro : le dossier où l'on range.
    writeProjectsDir(ctx.db, user.id, resolve(body.parentDir))

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
          instructionsMode: body.instructionsMode,
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
      // Relu puis réécrit en entier : l'écran n'édite qu'un CLI à la fois, et écrire
      // les deux écraserait le préréglage que l'autre onglet vient peut-être de poser.
      const current = readProjectDefaults(project.defaultConfig)
      patch.defaultConfig = serializeProjectDefaults({
        ...current,
        [body.defaultConfig.agent]: body.defaultConfig.config,
      })
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
    const tickets = ctx.db.select({ id: cards.id }).from(cards).where(eq(cards.projectId, id)).all()
    await attachments.removeForCards(tickets.map((row) => row.id))
    // Même raison pour l'index de recherche, que la cascade SQL n'atteint pas.
    for (const row of owned) dropConversation(ctx.db, row.id)

    // Le workspace sur disque n'est jamais touché : Sillage pointe dessus, ne le possède
    // pas. Les shells du projet, en revanche, tournent en son nom : on les ferme.
    terminals.closeForProject(id)
    // Les skills du projet, eux, appartiennent à Sillage. Avant la cascade, qui efface
    // les lignes dont on a besoin pour retrouver les skills désactivés.
    new SkillLibrary(ctx.db, ctx.config.paths.skillLibrary).removeProject(id)
    await ctx.db.delete(projects).where(eq(projects.id, id))
    return reply.status(204).send()
  })

  /**
   * L'image du projet. Lisible par quiconque voit le projet, comme son nom.
   *
   * L'URL donnée au client porte la date de l'image : chaque version a la sienne, d'où
   * le cache immuable.
   */
  /**
   * Épingle ou désépingle le projet pour le compte appelant.
   *
   * Ouvert à tout membre qui voit le projet : épingler n'est pas le modifier. Idempotent
   * des deux côtés, comme le signet de conversation, pour que le client n'ait pas à
   * connaître l'état d'avant.
   */
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
        // Un SVG ouvert dans son propre onglet est un document, scripts compris, et il
        // vient parfois d'un dépôt cloné : le bac à sable le réduit à une image.
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .header('cache-control', 'private, max-age=31536000, immutable')
        .send(image.data)
    )
  })

  /** Une image choisie par une personne : elle n'est jamais provisoire. */
  app.put('/api/projects/:id/image', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const project = await loadVisibleProject(id, user.id)
    if (project.ownerId !== user.id) {
      throw forbidden('project_edit_forbidden', 'Only the owner can modify this project.')
    }

    const file = await request.file({ limits: { fileSize: MAX_PROJECT_IMAGE_BYTES } })
    if (!file) throw badRequest('no_file', 'No file received.')
    // `toBuffer` échoue quand la limite est franchie, comme pour les pièces jointes.
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
