import type { FastifyInstance } from 'fastify'
import {
  createSkillSourceBodySchema,
  installSourceSkillBodySchema,
  sourceSkillPathSchema,
  updateSkillSourceBodySchema,
  type LibrarySkillDto,
  type LibrarySkillUpdateDto,
  type SkillSearchDto,
  type SkillSourceCatalogDto,
  type SkillSourceDto,
  type SkillSourceListDto,
  type SourceSkillPreviewDto,
} from '@sillage/protocol'
import { z } from 'zod'
import { credentialEnv } from '../../git-credential/helper.js'
import { comparableUrl, normalizeSourceUrl, type SkillSources } from '../../skill-library/sources.js'
import { searchSkillsSh } from '../../skill-library/skills-sh.js'
import type { SkillLibrary } from '../../skill-library/store.js'
import type { AppContext } from '../context.js'
import { conflict } from '../errors.js'
import { requireAdmin, requireUser } from '../require-user.js'
import { skillAccess } from './skill-library.js'

/** Skill library sources and updates to their skills. Only administrators can declare, edit or refresh sources because these operations bring third-party repository content onto the server. Everyone may browse catalogs and review skills. Installation and updates require write access to the destination scope, like other library writes. */
export function registerSkillSourceRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  library: SkillLibrary,
  sources: SkillSources,
): void {
  const { assertCanWrite, requireSkill } = skillAccess(ctx, library)
  const requireSource = (params: unknown) => sources.row((params as { id: string }).id)
  const pathQuery = z.object({ path: sourceSkillPathSchema.default('') })

  app.get('/api/skill-sources', async (request): Promise<SkillSourceListDto> => {
    requireUser(request)
    return { sources: sources.list().map((row) => sources.toDto(row)) }
  })

  app.post('/api/skill-sources', async (request, reply): Promise<SkillSourceDto> => {
    requireAdmin(request)
    const row = sources.create(createSkillSourceBodySchema.parse(request.body))
    reply.status(201)
    return sources.toDto(row)
  })

  app.patch('/api/skill-sources/:id', async (request): Promise<SkillSourceDto> => {
    requireAdmin(request)
    const row = sources.update(requireSource(request.params), updateSkillSourceBodySchema.parse(request.body))
    return sources.toDto(row)
  })

  app.delete('/api/skill-sources/:id', async (request, reply) => {
    requireAdmin(request)
    sources.remove(requireSource(request.params))
    reply.status(204)
  })

  /** Clones or refreshes using the requesting administrator's git credentials. Synchronous: depth-1 clones take seconds, and the interface waits for the response before showing the catalog. */
  app.post('/api/skill-sources/:id/refresh', async (request): Promise<SkillSourceDto> => {
    const user = requireAdmin(request)
    const row = await sources.refresh(requireSource(request.params), credentialEnv(ctx.config.paths, user.id))
    return sources.toDto(row)
  })

  app.get('/api/skill-sources/:id/catalog', async (request): Promise<SkillSourceCatalogDto> => {
    requireUser(request)
    const source = requireSource(request.params)
    const installed = library.installedFrom(source.id)
    return {
      source: sources.toDto(source),
      skills: sources.entries(source).map((entry) => ({
        path: entry.path,
        name: entry.name,
        description: entry.description,
        problem: entry.problem,
        scripts: entry.scripts,
        installed: installed
          .filter((row) => row.sourcePath === entry.path)
          .map((row) => ({
            skillId: row.id,
            scope: row.scope,
            projectId: row.projectId,
            name: row.name,
            updateAvailable: row.sourceHash !== null && row.sourceHash !== entry.hash,
          })),
      })),
    }
  })

  app.get('/api/skill-sources/:id/preview', async (request): Promise<SourceSkillPreviewDto> => {
    requireUser(request)
    return sources.preview(requireSource(request.params), pathQuery.parse(request.query).path)
  })

  app.post('/api/skill-sources/:id/install', async (request, reply): Promise<LibrarySkillDto> => {
    const user = requireUser(request)
    const source = requireSource(request.params)
    const body = installSourceSkillBodySchema.parse(request.body)
    assertCanWrite(user, body.scope, body.projectId)
    const entry = sources.entry(source, body.path)
    const installed = library.install(sources.files(source, body.path), body, user.id, {
      sourceId: source.id,
      path: entry.path,
      commit: entry.commit,
      hash: entry.hash,
    })
    reply.status(201)
    return installed
  })

  /** skills.sh repository discovery. Administrators only because only they can add the source identified by results. */
  app.get('/api/skill-sources/search', async (request): Promise<SkillSearchDto> => {
    requireAdmin(request)
    const { q } = z.object({ q: z.string().trim().min(1).max(100) }).parse(request.query)
    const results = await searchSkillsSh(q)
    if (!results) return { available: false, results: [] }
    const known = new Map(sources.list().map((source) => [comparableUrl(source.url), source.id]))
    return {
      available: true,
      results: results.map((result) => ({
        ...result,
        sourceId: known.get(comparableUrl(normalizeSourceUrl(result.repository).url)) ?? null,
      })),
    }
  })

  /** Skill, source and changes an update would make. */
  const pendingUpdate = (params: unknown, user: Parameters<typeof requireSkill>[1]) => {
    const row = requireSkill(params, user)
    if (row.sourceId === null || row.sourcePath === null) {
      throw conflict('skill_not_from_source', 'This skill was not installed from a source.')
    }
    const source = sources.row(row.sourceId)
    const entry = sources.entry(source, row.sourcePath)
    return { row, source, entry, files: sources.files(source, row.sourcePath) }
  }

  app.get('/api/skill-library/:id/update', async (request): Promise<LibrarySkillUpdateDto> => {
    const user = requireUser(request)
    const { row, entry, files } = pendingUpdate(request.params, user)
    return {
      skill: library.list(row.projectId).find((skill) => skill.id === row.id)!,
      fromCommit: row.sourceCommit ?? '',
      toCommit: entry.commit,
      patch: await sources.updatePatch(library, row, files),
    }
  })

  app.post('/api/skill-library/:id/update', async (request): Promise<LibrarySkillDto> => {
    const user = requireUser(request)
    const { row, source, entry, files } = pendingUpdate(request.params, user)
    assertCanWrite(user, row.scope, row.projectId)
    return library.applyUpdate(row, files, { sourceId: source.id, path: entry.path, commit: entry.commit, hash: entry.hash })
  })
}
