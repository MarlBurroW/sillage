import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { projects, type ProjectRow, type UserRow } from '@sillage/db'
import {
  updateInstructionsBodySchema,
  updateProjectInstructionsBodySchema,
  writeRepoInstructionsBodySchema,
  type InstructionsDto,
  type ProjectInstructionsDto,
  type RepoInstructionFileDto,
} from '@sillage/protocol'
import {
  instructionsAuthor,
  readInstructions,
  readRepoInstructionFiles,
  resolveInstructionsMode,
  writeInstructions,
} from '../../instructions/store.js'
import type { AppContext } from '../context.js'
import { forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'
import { visibleProject } from './projects.js'

/** SILLAGE.md edited through the interface. Permissions match the skill library: everyone reads global instructions, only administrators write them because they enter every session; project members read project instructions and owners edit them. Writes affect subsequently started sessions. Claude records its system prompt at the first exchange and reuses it when resuming; open sessions retain their version until their next compaction. */
export function registerInstructionRoutes(app: FastifyInstance, ctx: AppContext): void {
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

  const globalDto = (user: UserRow): InstructionsDto => {
    const row = readInstructions(ctx.db, null)
    return {
      content: row?.content ?? '',
      updatedAt: row?.updatedAt ?? null,
      author: instructionsAuthor(ctx.db, row, user.id),
      canEdit: user.isAdmin,
    }
  }

  const projectDto = async (
    project: ProjectRow,
    user: UserRow,
  ): Promise<ProjectInstructionsDto> => {
    const row = readInstructions(ctx.db, project.id)
    return {
      content: row?.content ?? '',
      updatedAt: row?.updatedAt ?? null,
      author: instructionsAuthor(ctx.db, row, user.id),
      canEdit: project.ownerId === user.id,
      mode: resolveInstructionsMode(project),
      modeChosen: project.instructionsMode !== null,
      repoFiles: await readRepoInstructionFiles(project.workspacePath),
    }
  }

  app.get('/api/instructions', async (request): Promise<InstructionsDto> => {
    return globalDto(requireUser(request))
  })

  app.put('/api/instructions', async (request): Promise<InstructionsDto> => {
    const user = requireUser(request)
    if (!user.isAdmin) throw forbidden('admin_only', 'Administrators only.')
    const body = updateInstructionsBodySchema.parse(request.body)
    writeInstructions(ctx.db, null, body.content, user.id)
    return globalDto(user)
  })

  app.get('/api/projects/:id/instructions', async (request): Promise<ProjectInstructionsDto> => {
    const user = requireUser(request)
    const project = requireProject((request.params as { id: string }).id, user)
    return projectDto(project, user)
  })

  /** Changes mode, content or both: repository-file migration imports text and switches mode together. Writing content for a project predating this setting selects `sillage`, otherwise a later `AGENTS.md` would silence the newly written instructions. */
  app.patch('/api/projects/:id/instructions', async (request): Promise<ProjectInstructionsDto> => {
    const user = requireUser(request)
    let project = requireProject((request.params as { id: string }).id, user)
    assertOwner(project, user)
    const body = updateProjectInstructionsBodySchema.parse(request.body)

    const mode =
      body.mode ?? (body.content !== undefined && project.instructionsMode === null ? 'sillage' : null)
    if (mode && mode !== project.instructionsMode) {
      ctx.db.update(projects).set({ instructionsMode: mode }).where(eq(projects.id, project.id)).run()
      project = { ...project, instructionsMode: mode }
    }
    if (body.content !== undefined) writeInstructions(ctx.db, project.id, body.content, user.id)
    return projectDto(project, user)
  })

  /** Writes a repository instruction file at the workspace root. The schema allows only `AGENTS.md` and `CLAUDE.md`: this route avoids opening a file editor solely to review instructions, rather than serving as a general editor. */
  app.put(
    '/api/projects/:id/instructions/repo-file',
    async (request): Promise<RepoInstructionFileDto> => {
      const user = requireUser(request)
      const project = requireProject((request.params as { id: string }).id, user)
      assertOwner(project, user)
      const body = writeRepoInstructionsBodySchema.parse(request.body)
      await writeFile(join(project.workspacePath, body.path), body.content, 'utf8')
      return { path: body.path, content: body.content }
    },
  )
}
