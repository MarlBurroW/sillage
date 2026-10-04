import type { FastifyInstance } from 'fastify'
import type { LibrarySkillRow, UserRow } from '@sillage/db'
import {
  createLibrarySkillBodySchema,
  updateLibrarySkillBodySchema,
  type LibrarySkillDetailDto,
  type LibrarySkillDto,
  type LibrarySkillListDto,
  type LibrarySkillScope,
} from '@sillage/protocol'
import type { SkillLibrary } from '../../skill-library/store.js'
import type { AppContext } from '../context.js'
import { forbidden, notFound } from '../errors.js'
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
}
