import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { projects, worktrees } from '@sillage/db'
import {
  EFFORT_FIELD,
  type AgentConfig,
  type TaskAgentDto,
  type TaskProjectDto,
} from '@sillage/protocol'
import type { AgentRegistry } from '../../agents/registry.js'
import { readGitStatus } from '../../git.js'
import type { AppContext } from '../context.js'
import { requireScope } from '../require-user.js'

/**
 * Les deux appels de découverte : ce qu'un client fait une fois, puis met en cache.
 *
 * L'adressage se fait par identifiant et jamais par nom, `projects.name` n'ayant aucune
 * contrainte d'unicité : deux projets homonymes rendraient l'adressage ambigu.
 */
export function registerDiscoveryRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  registry: AgentRegistry,
): void {
  app.get('/api/v1/projects', async (request) => {
    const { token, user } = requireScope(request, 'projects:read')
    const allowed = JSON.parse(token.projectIds) as string[]

    const rows = ctx.db
      .select()
      .from(projects)
      .where(
        and(
          isNull(projects.archivedAt),
          or(eq(projects.ownerId, user.id), eq(projects.visibility, 'shared')),
          allowed.length > 0 ? inArray(projects.id, allowed) : undefined,
        ),
      )
      .orderBy(asc(projects.position))
      .all()

    const tokenConfig = JSON.parse(token.config) as AgentConfig

    return Promise.all(
      rows.map(async (project): Promise<TaskProjectDto> => {
        const trees = ctx.db
          .select()
          .from(worktrees)
          .where(and(eq(worktrees.projectId, project.id), isNull(worktrees.removedAt)))
          .orderBy(asc(worktrees.createdAt))
          .all()

        return {
          id: project.id,
          name: project.name,
          workspacePath: project.workspacePath,
          git: (await readGitStatus(project.workspacePath)) !== null,
          worktrees: trees.map((tree) => ({
            id: tree.id,
            name: tree.name,
            branch: tree.baseRef,
          })),
          // Ce qu'une tâche obtiendra si elle ne demande rien : le jeton l'emporte sur
          // le projet, dont le préréglage ne vaut que pour un autre CLI.
          defaults: { agent: token.agent, config: tokenConfig },
        }
      }),
    )
  })

  /**
   * Ce que chaque CLI accepte en surcharge.
   *
   * Le catalogue est lu sur le CLI installé, donc il peut être injoignable : un agent
   * absent se dit `available: false` avec une liste vide, plutôt que de faire échouer
   * l'appel entier pour l'agent que l'appelant n'utilisait pas.
   */
  app.get('/api/v1/agents', async (request) => {
    requireScope(request, 'projects:read')

    const agents = await Promise.all(
      registry.all().map(async (adapter): Promise<TaskAgentDto> => {
        const base: TaskAgentDto = {
          agent: adapter.kind,
          label: adapter.label,
          available: false,
          effortField: EFFORT_FIELD[adapter.kind],
          models: [],
        }

        try {
          const catalog = await adapter.models()
          return {
            ...base,
            available: true,
            models: catalog.models.map((model) => ({
              value: model.value,
              displayName: model.displayName,
              isDefault: model.isDefault,
              efforts: model.efforts.map((effort) => effort.value),
            })),
          }
        } catch {
          return base
        }
      }),
    )

    return { agents }
  })
}
