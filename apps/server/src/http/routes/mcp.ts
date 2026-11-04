import { randomUUID } from 'node:crypto'
import { and, eq, isNull, or } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { conversations, mcpServers, projects } from '@sillage/db'
import {
  answerMcpInstallBodySchema,
  createMcpServerBodySchema,
  isReservedMcpServerName,
  updateMcpServerBodySchema,
  type McpServer,
  type McpServerListDto,
} from '@sillage/protocol'
import { answerMcpInstall, McpInstallRefusal, pendingMcpInstall, type McpInstallDeps } from '../../agents/mcp-install.js'
import { rowToMcpServer } from '../../agents/mcp-registry.js'
import type { AppContext } from '../context.js'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { visibilityFilter } from './projects.js'
import { requireAdmin, requireUser } from '../require-user.js'

/**
 * MCP server registry: instance-wide entries plus entries scoped to one project.
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
  /** `formerProjectId`: the scope before the write, which a deletion or a move can no longer read back. */
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

  /** A scope must point at a real project: a typo would create a server nobody can see. */
  const requireProject = (projectId: string | null): void => {
    if (projectId === null) return
    if (!ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get()) {
      throw notFound('project_not_found', 'Unknown project.')
    }
  }

  const requireServer = (params: unknown) => {
    const { id } = params as { id: string }
    const row = ctx.db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()
    if (!row) throw notFound('mcp_server_not_found', 'Unknown MCP server.')
    return row
  }

  app.get('/api/mcp/servers', async (request): Promise<McpServerListDto> => {
    const user = requireUser(request)
    return { servers: listVisible(user.id), sillageServer: ctx.config.mcp.sillageServer }
  })

  app.post('/api/mcp/servers', async (request, reply): Promise<McpServer> => {
    requireAdmin(request)
    const body = createMcpServerBodySchema.parse(request.body)
    requireFreeName(body.name)
    requireProject(body.projectId)

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
    requireAdmin(request)
    const current = requireServer(request.params)
    const body = updateMcpServerBodySchema.parse(request.body)
    if (body.name !== undefined) requireFreeName(body.name, current.id)
    if (body.projectId !== undefined) requireProject(body.projectId)

    const next = {
      ...current,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.transport !== undefined ? { transport: JSON.stringify(body.transport) } : {}),
      ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
      updatedAt: Date.now(),
    }
    ctx.db.update(mcpServers).set(next).where(eq(mcpServers.id, current.id)).run()
    serverChanged(current.id, current.projectId)

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
    serverChanged(current.id, current.projectId)
    reply.status(204)
  })

  if (!install) return

  /**
   * Answer to an agent's proposal. Declining is the owner's call; installing needs the same right
   * as declaring a server by hand, and the typed secrets go to the store from here.
   */
  app.post('/api/conversations/:id/mcp-installs/:requestId', async (request): Promise<{ server: McpServer | null }> => {
    const user = requireUser(request)
    const { id, requestId } = request.params as { id: string; requestId: string }
    const body = answerMcpInstallBodySchema.parse(request.body)
    if (body.decision === 'installed' && !user.isAdmin) throw forbidden('admin_only', 'Administrators only.')

    const conversation = ctx.db.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.userId, user.id))).get()
    if (!conversation) throw notFound('conversation_not_found', 'Conversation not found.')
    const pending = pendingMcpInstall(install.log, id)
    if (!pending || pending.requestId !== requestId) {
      throw notFound('mcp_install_not_found', 'This proposal is no longer waiting for an answer.')
    }

    try {
      const server = await answerMcpInstall({ db: ctx.db, ...install }, conversation, pending, body, user.id)
      if (server?.projectId) serverChanged(server.id)
      return { server }
    } catch (err) {
      if (err instanceof McpInstallRefusal) throw badRequest('mcp_install_rejected', err.message)
      throw err
    }
  })
}
