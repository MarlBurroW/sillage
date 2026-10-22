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

/** Project memory read and edited through the interface. Members can read it and owners can edit it, like instructions. Agents write directly instead: Claude through the directory, Codex through the MCP server. */
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

  const assertSillageMemory = (project: ProjectRow): void => {
    if (project.memoryMode === 'native') {
      throw badRequest('memory_native', 'This project keeps memory in each CLI: nothing for Sillage to edit.')
    }
  }

  app.get('/api/projects/:id/memory', async (request): Promise<ProjectMemoryDto> => {
    const user = requireUser(request)
    const project = requireProject((request.params as { id: string }).id, user)
    // Native mode maintains no Sillage directory: nothing to list or create.
    if (project.memoryMode === 'native') {
      return { mode: 'native', dir: '', files: [], importedFrom: null, canEdit: project.ownerId === user.id }
    }
    const dir = dirOf(project)
    return {
      mode: 'sillage',
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
    assertSillageMemory(project)
    const body = writeMemoryFileBodySchema.parse(request.body)
    await writeMemoryFile(dirOf(project), requireFile(request.params), body.content)
    return reply.status(204).send()
  })

  app.delete('/api/projects/:id/memory/:file', async (request, reply) => {
    const user = requireUser(request)
    const project = requireProject((request.params as { id: string }).id, user)
    assertOwner(project, user)
    assertSillageMemory(project)
    await deleteMemoryFile(dirOf(project), requireFile(request.params))
    return reply.status(204).send()
  })
}
