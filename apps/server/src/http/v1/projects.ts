import type { FastifyInstance } from 'fastify'
import type { AgentConfig, TaskProjectDto } from '@sillage/protocol'
import { createProject } from '../../projects/create.js'
import { readGitStatus } from '../../git.js'
import type { AppContext } from '../context.js'
import { forbidden } from '../errors.js'
import { requireScope } from '../require-user.js'
import { allowedProjectIds } from './access.js'

export function registerProjectCreationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/projects', async (request, reply) => {
    const { token, user } = requireScope(request, 'projects:write')
    // Créer hors de la liste autorisée élargirait les droits confiés au jeton.
    if (allowedProjectIds(token).length > 0) {
      throw forbidden('project_creation_restricted', 'Creating projects requires a token without project restrictions.')
    }
    const row = await createProject(ctx, user.id, request.body)
    const dto: TaskProjectDto = {
      id: row.id,
      name: row.name,
      workspacePath: row.workspacePath,
      git: (await readGitStatus(row.workspacePath)) !== null,
      worktrees: [],
      defaults: { agent: token.agent, config: JSON.parse(token.config) as AgentConfig },
    }
    return reply.status(201).send(dto)
  })
}
