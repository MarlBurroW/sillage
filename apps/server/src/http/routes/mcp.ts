import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { mcpServers } from '@sillage/db'
import {
  createMcpServerBodySchema,
  isReservedMcpServerName,
  updateMcpServerBodySchema,
  type McpServer,
  type McpServerListDto,
} from '@sillage/protocol'
import { rowToMcpServer } from '../../agents/mcp-registry.js'
import type { AppContext } from '../context.js'
import { conflict, notFound } from '../errors.js'
import { requireAdmin, requireUser } from '../require-user.js'

/**
 * Instance-wide MCP server registry.
 *
 * Only administrators may write: declaring an MCP server specifies a command
 * CLIs execute as the server's system user, granting execution rights rather
 * than changing display preferences.
 *
 * Edits reach open sessions using the server through `serverChanged`: each runner
 * applies them live when its CLI can, otherwise restarts once its turn ends.
 * Without it, a fixed URL or token stayed broken until a new conversation.
 */
export function registerMcpRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  serverChanged: (serverId: string) => void = () => {},
): void {
  const listAll = (): McpServer[] =>
    ctx.db.select().from(mcpServers).orderBy(mcpServers.name).all().map(rowToMcpServer)

  /**
   * Names are CLI keys: duplicate names silently overwrite each other in the
   * supplied map. The database already enforces uniqueness; this check returns
   * a translatable code instead of a constraint error.
   */
  const requireFreeName = (name: string, exceptId?: string): void => {
    // Sillage's own server is absent from this table, so database uniqueness cannot
    // protect it. An entry with its name would replace it in the CLI configuration,
    // and the agent would lose history access without
    // any error being reported.
    if (isReservedMcpServerName(name)) {
      throw conflict('mcp_server_name_reserved', 'The name {name} is reserved by Sillage.', {
        name,
      })
    }

    const existing = ctx.db.select().from(mcpServers).where(eq(mcpServers.name, name)).get()
    if (existing && existing.id !== exceptId) {
      throw conflict('mcp_server_name_taken', 'An MCP server named {name} already exists.', { name })
    }
  }

  const requireServer = (params: unknown) => {
    const { id } = params as { id: string }
    const row = ctx.db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()
    if (!row) throw notFound('mcp_server_not_found', 'Unknown MCP server.')
    return row
  }

  app.get('/api/mcp/servers', async (request): Promise<McpServerListDto> => {
    requireUser(request)
    return { servers: listAll(), sillageServer: ctx.config.mcp.sillageServer }
  })

  app.post('/api/mcp/servers', async (request, reply): Promise<McpServer> => {
    requireAdmin(request)
    const body = createMcpServerBodySchema.parse(request.body)
    requireFreeName(body.name)

    const now = Date.now()
    const row = {
      id: randomUUID(),
      name: body.name,
      enabled: body.enabled,
      transport: JSON.stringify(body.transport),
      createdAt: now,
      updatedAt: now,
    }
    ctx.db.insert(mcpServers).values(row).run()

    reply.status(201)
    return rowToMcpServer(row)
  })

  app.patch('/api/mcp/servers/:id', async (request): Promise<McpServer> => {
    requireAdmin(request)
    const current = requireServer(request.params)
    const body = updateMcpServerBodySchema.parse(request.body)
    if (body.name !== undefined) requireFreeName(body.name, current.id)

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
    requireAdmin(request)
    const current = requireServer(request.params)
    ctx.db.delete(mcpServers).where(eq(mcpServers.id, current.id)).run()
    serverChanged(current.id)
    reply.status(204)
  })
}
