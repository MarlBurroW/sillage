import type { FastifyInstance } from 'fastify'
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { cards, conversations, projects } from '@sillage/db'
import {
  paletteFilesQuerySchema,
  type PaletteCatalogDto,
  type PaletteFilesDto,
} from '@sillage/protocol'
import { searchProjectFiles, type FileSearchTarget } from '../../search/search-files.js'
import type { SkillLibrary } from '../../skill-library/store.js'
import { conversationWorkspace } from '../../workspace.js'
import type { AppContext } from '../context.js'
import { requireUser } from '../require-user.js'

/** Search palette data not already available in interface lists. Only visible, unarchived projects: the palette sees the same projects as navigation and message search. */
export function registerPaletteRoutes(app: FastifyInstance, ctx: AppContext, library: SkillLibrary): void {
  const visibleProjects = (userId: string) =>
    ctx.db
      .select({ id: projects.id, name: projects.name, workspacePath: projects.workspacePath })
      .from(projects)
      .where(and(or(eq(projects.ownerId, userId), eq(projects.visibility, 'shared')), isNull(projects.archivedAt)))
      .all()

  app.get('/api/palette/catalog', async (request): Promise<PaletteCatalogDto> => {
    const user = requireUser(request)
    const ids = visibleProjects(user.id).map((project) => project.id)
    if (ids.length === 0) return { cards: [], skills: library.summaries([]) }

    const rows = ctx.db
      .select({
        id: cards.id,
        projectId: cards.projectId,
        number: cards.number,
        title: cards.title,
        column: cards.column,
      })
      .from(cards)
      .where(inArray(cards.projectId, ids))
      .all()
    return { cards: rows, skills: library.summaries(ids) }
  })

  app.get('/api/palette/files', async (request): Promise<PaletteFilesDto> => {
    const user = requireUser(request)
    const { q, conversationId } = paletteFilesQuerySchema.parse(request.query)

    const targets: FileSearchTarget[] = visibleProjects(user.id).map((project) => ({
      projectId: project.id,
      projectName: project.name,
      cwd: project.workspacePath,
    }))

    if (conversationId) {
      const row = ctx.db
        .select({ projectId: conversations.projectId })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .get()
      const target = targets.find((entry) => entry.projectId === row?.projectId)
      // `conversationWorkspace` repeats access checks; invisible conversations belong
      // to invisible projects, which are absent from `targets`, so nothing
      // is substituted.
      if (target) target.cwd = conversationWorkspace(ctx.db, conversationId, user.id)
    }

    return { projects: await searchProjectFiles(targets, q) }
  })
}
