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

/**
 * Palette de recherche : ce qu'aucune liste de l'interface ne porte déjà.
 *
 * Projets visibles et non archivés seulement : la palette voit ce que la navigation
 * voit, comme la recherche dans les messages.
 */
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
      // `conversationWorkspace` refait le contrôle d'accès ; une conversation que ce
      // compte ne voit pas appartient à un projet qu'il ne voit pas non plus, absent
      // de `targets`, donc rien n'est substitué.
      if (target) target.cwd = conversationWorkspace(ctx.db, conversationId, user.id)
    }

    return { projects: await searchProjectFiles(targets, q) }
  })
}
