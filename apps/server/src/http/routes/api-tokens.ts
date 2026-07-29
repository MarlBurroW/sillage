import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { apiTokens, projects } from '@sillage/db'
import {
  createApiTokenBodySchema,
  isPermissiveConfig,
  updateApiTokenBodySchema,
  type CreatedApiTokenDto,
} from '@sillage/protocol'
import type { AgentRegistry } from '../../agents/registry.js'
import {
  apiTokenToDto,
  createApiToken,
  findApiToken,
  listApiTokens,
} from '../../auth/api-tokens.js'
import type { AppContext } from '../context.js'
import { badRequest, conflict, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/**
 * Administration des jetons d'API, réservée au cookie de session.
 *
 * Elle vit sous `/api/tokens` et non sous `/api/v1` : un jeton ne doit pas pouvoir
 * s'en fabriquer un autre, ni élargir ses portées. Créer un accès machine reste un
 * geste humain.
 */
export function registerApiTokenRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  registry: AgentRegistry,
): void {
  /** Un jeton ne peut viser que des projets que son propriétaire voit déjà. */
  const assertProjectsVisible = (userId: string, projectIds: string[]): void => {
    if (projectIds.length === 0) return

    const rows = ctx.db
      .select({ id: projects.id, ownerId: projects.ownerId, visibility: projects.visibility })
      .from(projects)
      .where(inArray(projects.id, projectIds))
      .all()

    const visible = new Set(
      rows.filter((row) => row.ownerId === userId || row.visibility === 'shared').map((row) => row.id),
    )
    const missing = projectIds.find((id) => !visible.has(id))
    if (missing) throw notFound('project_not_found', 'Project {id} not found.', { id: missing })
  }

  app.get('/api/tokens', async (request) => {
    const user = requireUser(request)
    return listApiTokens(ctx.db, user.id).map(apiTokenToDto)
  })

  app.post('/api/tokens', async (request, reply) => {
    const user = requireUser(request)
    const body = createApiTokenBodySchema.parse(request.body)

    if (body.config.agent !== body.agent) {
      throw badRequest('config_agent_mismatch', 'The configuration does not match the selected CLI.')
    }
    if (isPermissiveConfig(body.config) && !body.scopes.includes('tasks:autonomous')) {
      throw badRequest(
        'config_requires_autonomous',
        'A configuration without guardrails requires the tasks:autonomous scope.',
      )
    }
    assertProjectsVisible(user.id, body.projectIds)

    // Les `CLI_DEFAULT` sont résolus une fois ici, comme à la création d'une
    // conversation : le jeton porte ensuite une configuration explicite et stable.
    const config = await registry.adapter(body.agent).resolveDefaults(body.config)

    const { row, secret } = createApiToken(ctx.db, {
      userId: user.id,
      label: body.label,
      scopes: body.scopes,
      projectIds: body.projectIds,
      agent: body.agent,
      config,
      expiresAt: body.expiresAt,
      webhookUrl: body.webhookUrl,
    })

    const payload: CreatedApiTokenDto = {
      token: apiTokenToDto(row),
      secret,
      // Lisible en base contrairement au secret d'authentification, mais montré une
      // seule fois quand même : l'écran n'a aucune raison de le réexposer ensuite.
      webhookSecret: row.webhookSecret ?? '',
    }
    return reply.status(201).send(payload)
  })

  /** Révocation, seule modification possible : voir `updateApiTokenBodySchema`. */
  app.patch('/api/tokens/:id', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    updateApiTokenBodySchema.parse(request.body)

    const row = findApiToken(ctx.db, id, user.id)
    if (!row) throw notFound('token_not_found', 'Token not found.')
    if (row.revokedAt !== null) {
      throw conflict('token_revoked', 'This token is already revoked.')
    }

    ctx.db.update(apiTokens).set({ revokedAt: Date.now() }).where(eq(apiTokens.id, id)).run()
    return apiTokenToDto({ ...row, revokedAt: Date.now() })
  })

  /**
   * La suppression n'est offerte que sur un jeton déjà révoqué : elle est définitive et
   * un jeton encore vivant se coupe d'abord, pour que le geste soit en deux temps.
   * Les conversations qu'il a lancées gardent leur marqueur, qui est recopié sur elles.
   */
  app.delete('/api/tokens/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    const row = findApiToken(ctx.db, id, user.id)
    if (!row) throw notFound('token_not_found', 'Token not found.')
    if (row.revokedAt === null) {
      throw conflict('token_not_revoked', 'Revoke the token before deleting it.')
    }

    ctx.db.delete(apiTokens).where(and(eq(apiTokens.id, id), eq(apiTokens.userId, user.id))).run()
    return reply.status(204).send()
  })
}
