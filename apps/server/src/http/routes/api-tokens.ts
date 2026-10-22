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
 * API token administration, reserved for session cookies.
 *
 * Lives under `/api/tokens`, outside `/api/v1`: tokens must not mint more tokens
 * or expand their scopes. Creating machine access remains a human action.
 */
export function registerApiTokenRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  registry: AgentRegistry,
): void {
  /** A token can only target projects its owner can already see. */
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

    // Resolve `CLI_DEFAULT` once here, as when creating conversations:
    // the token then carries an explicit, stable configuration.
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
      // Readable in the database unlike authentication secrets, but still displayed
      // only once: the interface has no reason to expose it again later.
      webhookSecret: row.webhookSecret ?? '',
    }
    return reply.status(201).send(payload)
  })

  /** Revocation is the only modification allowed; see `updateApiTokenBodySchema`. */
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
   * Only revoked tokens can be deleted: deletion is permanent, so active tokens
   * must first be disabled to make this a two-step action. Their conversations
   * retain the origin marker copied onto them.
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
