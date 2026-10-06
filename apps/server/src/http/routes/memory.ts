import type { FastifyInstance } from 'fastify'
import type { ProjectRow, UserRow } from '@sillage/db'
import { memoryFileSchema, writeMemoryFileBodySchema, type ProjectMemoryDto } from '@sillage/protocol'
import {
  deleteMemoryFile,
  ensureProjectMemory,
  listMemory,
  readImportMarker,
  writeMemoryFile,
} from '../../memory/store.js'
import type { AppContext } from '../context.js'
import { badRequest, forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'
import { visibleProject } from './projects.js'

/**
 * La mémoire d'un projet, lue et corrigée depuis l'interface.
 *
 * Les membres du projet la lisent, son propriétaire la modifie, comme les consignes. Les
 * agents, eux, y écrivent sans passer par ici : Claude dans le dossier, Codex par le
 * serveur MCP.
 */
export function registerMemoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const requireProject = (projectId: string, user: UserRow): ProjectRow => {
    const project = visibleProject(ctx, projectId, user.id)
    if (!project) throw notFound('project_not_found', 'Project not found.')
    return project
  }

  const assertOwner = (project: ProjectRow, user: UserRow): void => {
    if (project.ownerId !== user.id) {
      throw forbidden('project_edit_forbidden', 'Only the owner can modify this project.')
    }
  }

  const requireFile = (params: unknown): string => {
    const parsed = memoryFileSchema.safeParse((params as { file: string }).file)
    if (!parsed.success) throw badRequest('memory_file_invalid', 'Expected a flat markdown file name.')
    return parsed.data
  }

  const dirOf = (project: ProjectRow) =>
    ensureProjectMemory(ctx.config.paths.memory, project.id, project.workspacePath)

  app.get('/api/projects/:id/memory', async (request): Promise<ProjectMemoryDto> => {
    const user = requireUser(request)
    const project = requireProject((request.params as { id: string }).id, user)
    const dir = dirOf(project)
    return {
      dir,
      files: await listMemory(dir),
      importedFrom: readImportMarker(dir),
      canEdit: project.ownerId === user.id,
    }
  })

  app.put('/api/projects/:id/memory/:file', async (request, reply) => {
    const user = requireUser(request)
    const project = requireProject((request.params as { id: string }).id, user)
    assertOwner(project, user)
    const body = writeMemoryFileBodySchema.parse(request.body)
    await writeMemoryFile(dirOf(project), requireFile(request.params), body.content)
    return reply.status(204).send()
  })

  app.delete('/api/projects/:id/memory/:file', async (request, reply) => {
    const user = requireUser(request)
    const project = requireProject((request.params as { id: string }).id, user)
    assertOwner(project, user)
    await deleteMemoryFile(dirOf(project), requireFile(request.params))
    return reply.status(204).send()
  })
}
