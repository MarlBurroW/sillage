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
 * The two discovery calls: clients make them once, then cache their results.
 *
 * Address by ID, never by name: `projects.name` has no uniqueness constraint, so
 * identically named projects would make name-based addressing ambiguous.
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
            // A worktree's name is its branch; `baseRef` only identifies its starting point.
            branch: tree.name,
          })),
          // Defaults a task gets when it specifies nothing: the token overrides the
          // project, whose preset only applies to a different CLI.
          defaults: { agent: token.agent, config: tokenConfig },
        }
      }),
    )
  })

  /**
   * Overrides accepted by each CLI.
   *
   * Catalogs come from installed CLIs and may be unreachable. Report missing
   * agents as `available: false` with an empty list instead of failing the whole
   * call because of an agent the caller does not use.
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
          outputStyles: [],
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
            outputStyles: catalog.outputStyles,
          }
        } catch {
          return base
        }
      }),
    )

    return { agents }
  })
}
