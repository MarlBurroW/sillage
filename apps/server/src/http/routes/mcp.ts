import { randomUUID } from 'node:crypto'
import { and, eq, isNull, or } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { conversations, mcpServers, projects, type McpServerRow, type UserRow } from '@sillage/db'
import {
  answerMcpInstallBodySchema,
  createMcpServerBodySchema,
  updateMcpServerBodySchema,
  type McpServer,
  type McpServerListDto,
} from '@sillage/protocol'
import {
  answerMcpInstall,
  assertFreeMcpServerName,
  pendingMcpInstall,
  type McpInstallDeps,
} from '../../agents/mcp-install.js'
import { rowToMcpServer } from '../../agents/mcp-registry.js'
import type { AppContext } from '../context.js'
import { notFound } from '../errors.js'
import { requireUser } from '../require-user.js'
import { assertScopeWriter } from '../scope-access.js'
import { visibilityFilter, visibleProject } from './projects.js'

/**
 * MCP server registry: global entries plus entries scoped to one project.
 *
 * Writes follow the scope rule (`scope-access.ts`): administrators for global servers, the
 * project owner for a project's. A server names a command CLIs execute as the server's system
 * user, but so does any terminal or action of the project, which its members already have.
 *
 * Edits reach open sessions using the server through `serverChanged`: each runner
 * applies them live when its CLI can, otherwise restarts once its turn ends.
 * Without it, a fixed URL or token stayed broken until a new conversation.
 */
export function registerMcpRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  /** `formerProjectId`: the scope before a deletion, which the row can no longer tell. */
  serverChanged: (serverId: string, formerProjectId?: string | null) => void = () => {},
  install?: Omit<McpInstallDeps, 'db'>,
): void {
  /** Global entries and those of projects the account can open; other projects' servers stay private to them. */
  const listVisible = (userId: string): McpServer[] =>
    ctx.db
      .select({ server: mcpServers })
      .from(mcpServers)
      .leftJoin(projects, eq(projects.id, mcpServers.projectId))
      .where(or(isNull(mcpServers.projectId), visibilityFilter(userId)))
      .orderBy(mcpServers.name)
      .all()
      .map((row) => rowToMcpServer(row.server))

  /** A server of a project the caller cannot see is reported as nonexistent, not forbidden. */
  const requireServer = (params: unknown, user: UserRow): McpServerRow => {
    const { id } = params as { id: string }
    const row = ctx.db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()
    if (!row || (row.projectId !== null && !visibleProject(ctx, row.projectId, user.id))) {
      throw notFound('mcp_server_not_found', 'Unknown MCP server.')
    }
    return row
  }

  app.get('/api/mcp/servers', async (request): Promise<McpServerListDto> => {
    const user = requireUser(request)
    return { servers: listVisible(user.id), sillageServer: ctx.config.mcp.sillageServer }
  })

  app.post('/api/mcp/servers', async (request, reply): Promise<McpServer> => {
    const user = requireUser(request)
    const body = createMcpServerBodySchema.parse(request.body)
    assertScopeWriter(ctx, user, body.projectId)
    assertFreeMcpServerName(ctx.db, body.name, body.projectId)

    const now = Date.now()
    const row = {
      id: randomUUID(),
      name: body.name,
      enabled: body.enabled,
      transport: JSON.stringify(body.transport),
      projectId: body.projectId,
      createdAt: now,
      updatedAt: now,
    }
    ctx.db.insert(mcpServers).values(row).run()
    // A project server applies to its conversations without selection: open ones must learn of it.
    if (row.projectId) serverChanged(row.id)

    reply.status(201)
    return rowToMcpServer(row)
  })

  app.patch('/api/mcp/servers/:id', async (request): Promise<McpServer> => {
    const user = requireUser(request)
    const current = requireServer(request.params, user)
    assertScopeWriter(ctx, user, current.projectId)
    const body = updateMcpServerBodySchema.parse(request.body)
    if (body.name !== undefined) assertFreeMcpServerName(ctx.db, body.name, current.projectId, current.id)

    const next = {
      ...current,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.transport !== undefined ? { transport: JSON.stringify(body.transport) } : {}),
      updatedAt: Date.now(),
    }
    ctx.db.update(mcpServers).set(next).where(eq(mcpServers.id, current.id)).run()
    serverChanged(current.id)

    return rowToMcpServer(next)
  })

  /**
   * Do not cascade into conversations: their configuration retains an ID the
   * registry no longer resolves. Entries can then be removed without rewriting
   * every referencing configuration; resolution ignores these orphaned IDs.
   */
  app.delete('/api/mcp/servers/:id', async (request, reply) => {
    const user = requireUser(request)
    const current = requireServer(request.params, user)
    assertScopeWriter(ctx, user, current.projectId)
    ctx.db.delete(mcpServers).where(eq(mcpServers.id, current.id)).run()
    serverChanged(current.id, current.projectId)
    reply.status(204)
  })

  if (!install) return

  /**
   * Answer to an agent's proposal, by the account the conversation belongs to. Declining needs
   * nothing more; installing needs the right to write the chosen scope, exactly as declaring the
   * server by hand would. The typed secrets go to the store from here.
   */
  app.post('/api/conversations/:id/mcp-installs/:requestId', async (request): Promise<{ server: McpServer | null }> => {
    const user = requireUser(request)
    const { id, requestId } = request.params as { id: string; requestId: string }
    const body = answerMcpInstallBodySchema.parse(request.body)

    const conversation = ctx.db.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.userId, user.id))).get()
    if (!conversation) throw notFound('conversation_not_found', 'Conversation not found.')
    const pending = pendingMcpInstall(install.log, id)
    if (!pending || pending.requestId !== requestId) {
      throw notFound('mcp_install_not_found', 'This proposal is no longer waiting for an answer.')
    }
    // A project scope without a project is refused with its own reason by `answerMcpInstall`.
    if (body.decision === 'installed' && (body.scope === 'global' || conversation.projectId)) {
      assertScopeWriter(ctx, user, body.scope === 'project' ? conversation.projectId : null)
    }

    const server = await answerMcpInstall({ db: ctx.db, ...install }, conversation, pending, body, {
      id: user.id,
      canReplaceSecrets: user.isAdmin,
    })
    if (server?.projectId) serverChanged(server.id)
    return { server }
  })
}
