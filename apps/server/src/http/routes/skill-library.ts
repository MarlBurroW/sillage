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
 * Skill library delivered to CLIs as native skills.
 *
 * Read access: all users for global scope, project members for project scope.
 * Write access: administrators globally, owners for projects. Global skills enter
 * every conversation's context and run scripts as the server's system user:
 * this grants execution rights just like an MCP server.
 *
 * Writes apply immediately to open sessions; see `SkillLibrary`.
 */
export function registerSkillLibraryRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  library: SkillLibrary,
): void {
  const { requireVisibleProject, assertCanWrite, requireSkill } = skillAccess(ctx, library)

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

  /** Changing scope requires write access at both the source and destination. */
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

  /** Path follows `/files/`, with each segment encoded separately by the client. */
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
   * One uploaded file per request, destination in a URL parameter: the same
   * rationale as explorer uploads (`routes/tree.ts`).
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
   * Machine directories visible to the caller: the system user's directories
   * for administrators, the project repository for its members.
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
   * Import only directories just offered to this caller by the scan: accepting
   * arbitrary client paths would copy any server directory into the library
   * and therefore into agent context.
   *
   * Repository skills are imported into the project whose workspace was scanned.
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
 * Library permissions shared with source routes: project visibility, scope
 * write access and skill visibility.
 */
export function skillAccess(ctx: AppContext, library: SkillLibrary) {
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

  /** Project skills invisible to the caller are reported as nonexistent, not forbidden. */
  const requireSkill = (params: unknown, user: UserRow): LibrarySkillRow => {
    const row = library.row((params as { id: string }).id)
    if (row.scope === 'project' && !visibleProject(ctx, row.projectId ?? '', user.id)) {
      throw notFound('skill_not_found', 'Unknown skill.')
    }
    return row
  }

  return { requireVisibleProject, assertCanWrite, requireSkill }
}

/**
 * Entire multipart upload held in memory: skills occupy a few kilobytes, and
 * the plugin's size limit bounds the rest.
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
