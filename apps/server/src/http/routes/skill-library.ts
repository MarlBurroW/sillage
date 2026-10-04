import { homedir } from 'node:os'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { LibrarySkillRow, UserRow } from '@sillage/db'
import {
  MAX_ATTACHMENT_BYTES,
  adoptLibrarySkillBodySchema,
  createLibrarySkillBodySchema,
  duplicateLibrarySkillBodySchema,
  importLibrarySkillQuerySchema,
  updateLibrarySkillBodySchema,
  writeSkillFileBodySchema,
  type LibrarySkillDetailDto,
  type LibrarySkillDto,
  type LibrarySkillFileDto,
  type LibrarySkillListDto,
  type LibrarySkillScope,
  type LocalSkillListDto,
} from '@sillage/protocol'
import { z } from 'zod'
import { readSkillArchive } from '../../skill-library/archive.js'
import { scanLocalSkills } from '../../skill-library/local-scan.js'
import type { SkillLibrary } from '../../skill-library/store.js'
import type { AppContext } from '../context.js'
import { badRequest, forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'
import { visibleProject } from './projects.js'

/**
 * Bibliothèque de skills, livrée aux CLI comme des skills natifs.
 *
 * Lecture : tout utilisateur pour la portée globale, les membres du projet pour la
 * sienne. Écriture : les administrateurs pour le global, le propriétaire pour un projet.
 * Un skill global entre dans le contexte de toutes les conversations de l'instance, et
 * ses scripts s'exécutent sous l'utilisateur système du serveur : c'est un droit
 * d'exécution, au même titre qu'un serveur MCP.
 *
 * Une écriture vaut tout de suite pour les sessions ouvertes, voir `SkillLibrary`.
 */
export function registerSkillLibraryRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  library: SkillLibrary,
): void {
  const requireVisibleProject = (projectId: string, user: UserRow) => {
    const project = visibleProject(ctx, projectId, user.id)
    if (!project) throw notFound('project_not_found', 'Project not found.')
    return project
  }

  const assertCanWrite = (user: UserRow, scope: LibrarySkillScope, projectId: string | null): void => {
    if (scope === 'global') {
      if (!user.isAdmin) throw forbidden('admin_only', 'Administrators only.')
      return
    }
    const project = requireVisibleProject(projectId ?? '', user)
    if (project.ownerId !== user.id) {
      throw forbidden('project_edit_forbidden', 'Only the owner can modify this project.')
    }
  }

  /** Un skill de projet invisible pour l'appelant n'existe pas, plutôt qu'interdit. */
  const requireSkill = (params: unknown, user: UserRow): LibrarySkillRow => {
    const row = library.row((params as { id: string }).id)
    if (row.scope === 'project' && !visibleProject(ctx, row.projectId ?? '', user.id)) {
      throw notFound('skill_not_found', 'Unknown skill.')
    }
    return row
  }

  app.get('/api/skill-library', async (request): Promise<LibrarySkillListDto> => {
    const user = requireUser(request)
    const { projectId } = request.query as { projectId?: string }
    if (projectId) requireVisibleProject(projectId, user)
    return { skills: library.list(projectId ?? null), enabled: ctx.config.skills.library }
  })

  app.post('/api/skill-library', async (request, reply): Promise<LibrarySkillDto> => {
    const user = requireUser(request)
    const body = createLibrarySkillBodySchema.parse(request.body)
    assertCanWrite(user, body.scope, body.projectId)
    const created = library.create(body, user.id)
    reply.status(201)
    return created
  })

  app.get('/api/skill-library/:id', async (request): Promise<LibrarySkillDetailDto> => {
    const user = requireUser(request)
    return library.detail(requireSkill(request.params, user))
  })

  /** Changer de portée demande le droit d'écrire au départ et à l'arrivée. */
  app.patch('/api/skill-library/:id', async (request): Promise<LibrarySkillDto> => {
    const user = requireUser(request)
    const row = requireSkill(request.params, user)
    const body = updateLibrarySkillBodySchema.parse(request.body)
    assertCanWrite(user, row.scope, row.projectId)
    if (body.scope !== undefined) assertCanWrite(user, body.scope, body.projectId ?? null)
    return library.update(row, body)
  })

  app.delete('/api/skill-library/:id', async (request, reply) => {
    const user = requireUser(request)
    const row = requireSkill(request.params, user)
    assertCanWrite(user, row.scope, row.projectId)
    library.remove(row)
    reply.status(204)
  })

  /** Le chemin suit `/files/`, segments encodés un à un par le client. */
  const filePath = (request: FastifyRequest): string => (request.params as { '*': string })['*']

  app.get('/api/skill-library/:id/files/*', async (request): Promise<LibrarySkillFileDto> => {
    const user = requireUser(request)
    return library.readFile(requireSkill(request.params, user), filePath(request))
  })

  app.put('/api/skill-library/:id/files/*', async (request, reply) => {
    const user = requireUser(request)
    const row = requireSkill(request.params, user)
    assertCanWrite(user, row.scope, row.projectId)
    const { content } = writeSkillFileBodySchema.parse(request.body)
    library.writeFile(row, filePath(request), content)
    reply.status(204)
  })

  app.delete('/api/skill-library/:id/files/*', async (request, reply) => {
    const user = requireUser(request)
    const row = requireSkill(request.params, user)
    assertCanWrite(user, row.scope, row.projectId)
    library.deleteFile(row, filePath(request))
    reply.status(204)
  })

  /**
   * Un fichier déposé, un par requête, sa destination en paramètre d'URL : même
   * raisonnement que le dépôt dans l'explorateur (`routes/tree.ts`).
   */
  app.post('/api/skill-library/:id/upload', async (request, reply) => {
    const user = requireUser(request)
    const row = requireSkill(request.params, user)
    assertCanWrite(user, row.scope, row.projectId)
    const { path } = z.object({ path: z.string().min(1) }).parse(request.query)
    library.writeFile(row, path, await uploaded(request))
    reply.status(204)
  })

  app.get('/api/skill-library/:id/export', async (request, reply) => {
    const user = requireUser(request)
    const row = requireSkill(request.params, user)
    const archive = library.exportArchive(row)
    reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${row.name}.zip"`)
    return Buffer.from(archive)
  })

  app.post('/api/skill-library/import', async (request, reply): Promise<LibrarySkillDto> => {
    const user = requireUser(request)
    const target = importLibrarySkillQuerySchema.parse(request.query)
    assertCanWrite(user, target.scope, target.projectId)
    const files = readSkillArchive(await uploaded(request))
    const created = library.install(files, target, user.id)
    reply.status(201)
    return created
  })

  app.post('/api/skill-library/:id/duplicate', async (request, reply): Promise<LibrarySkillDto> => {
    const user = requireUser(request)
    const row = requireSkill(request.params, user)
    const target = duplicateLibrarySkillBodySchema.parse(request.body)
    assertCanWrite(user, target.scope, target.projectId)
    const created = library.duplicate(row, target, user.id)
    reply.status(201)
    return created
  })

  /**
   * Ce que l'appelant a le droit de voir sur la machine : les dossiers de l'utilisateur
   * système pour un administrateur, le dépôt du projet pour ses membres.
   */
  const scanFor = (user: UserRow, projectId: string | null) =>
    scanLocalSkills({
      home: user.isAdmin ? homedir() : null,
      codexHome: process.env.CODEX_HOME || null,
      workspace: projectId ? requireVisibleProject(projectId, user).workspacePath : null,
    })

  app.get('/api/skill-library/local', async (request): Promise<LocalSkillListDto> => {
    const user = requireUser(request)
    const { projectId } = request.query as { projectId?: string }
    return { skills: scanFor(user, projectId || null) }
  })

  /**
   * La reprise ne copie qu'un dossier que le scan vient de proposer à cet appelant : le
   * chemin vient du client, et le prendre tel quel ferait copier n'importe quel dossier
   * du serveur dans la bibliothèque, donc dans le contexte des agents.
   *
   * Un skill de dépôt se reprend dans son projet, celui dont le scan lit le workspace.
   */
  app.post('/api/skill-library/adopt', async (request, reply): Promise<LibrarySkillDto> => {
    const user = requireUser(request)
    const body = adoptLibrarySkillBodySchema.parse(request.body)
    assertCanWrite(user, body.scope, body.projectId)
    const candidate = scanFor(user, body.projectId).find((skill) => skill.path === body.path)
    if (!candidate) throw notFound('local_skill_not_found', 'This skill is no longer on the machine.')
    const created = library.adopt(candidate.path, body, user.id)
    reply.status(201)
    return created
  })
}

/**
 * Le fichier d'un envoi multipart, entier en mémoire : un skill tient en quelques
 * kilo-octets, et le plafond du greffon borne le reste.
 */
async function uploaded(request: FastifyRequest): Promise<Buffer> {
  const part = await request.file({ limits: { fileSize: MAX_ATTACHMENT_BYTES } })
  if (!part) throw badRequest('no_file', 'No file received.')
  const buffer = await part.toBuffer()
  if (part.file.truncated) {
    throw badRequest('skill_file_too_large', 'The file exceeds {megabytes} MB.', {
      megabytes: MAX_ATTACHMENT_BYTES / 1024 / 1024,
    })
  }
  return buffer
}
