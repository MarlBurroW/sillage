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
 * Registre des serveurs MCP, partagé par toute l'instance.
 *
 * Réservé aux administrateurs en écriture : déclarer un serveur MCP, c'est décrire une
 * commande que les CLI lanceront sous l'utilisateur système du serveur. C'est un droit
 * d'exécution, pas une préférence d'affichage.
 *
 * Un serveur modifié ne s'applique qu'au prochain lancement des conversations qui
 * l'utilisent. Rien ici ne va rejouer la configuration d'une session en cours : le
 * runner Claude ne renvoie ses serveurs que sur un changement de configuration de
 * conversation, et Codex ne sait pas les remplacer sans rouvrir son thread.
 */
export function registerMcpRoutes(app: FastifyInstance, ctx: AppContext): void {
  const listAll = (): McpServer[] =>
    ctx.db.select().from(mcpServers).orderBy(mcpServers.name).all().map(rowToMcpServer)

  /**
   * Le nom est la clé côté CLI : deux serveurs homonymes s'écraseraient en silence dans
   * la table transmise. La base porte déjà l'unicité, ce contrôle sert à répondre un
   * code que l'interface sait traduire plutôt qu'une erreur de contrainte.
   */
  const requireFreeName = (name: string, exceptId?: string): void => {
    // Le serveur que Sillage monte lui-même n'est pas dans cette table, donc l'unicité
    // de la base ne le protège pas : une entrée homonyme prendrait sa place dans la
    // configuration transmise au CLI, et l'agent perdrait l'accès à l'historique sans
    // qu'aucune erreur ne le signale.
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

    return rowToMcpServer(next)
  })

  /**
   * Pas de cascade vers les conversations : leur configuration garde l'identifiant, que
   * le registre ne résout plus. C'est ce qui permet de supprimer une entrée sans
   * réécrire la configuration de tout ce qui s'en servait, au prix d'un identifiant
   * orphelin que la résolution ignore.
   */
  app.delete('/api/mcp/servers/:id', async (request, reply) => {
    requireAdmin(request)
    const current = requireServer(request.params)
    ctx.db.delete(mcpServers).where(eq(mcpServers.id, current.id)).run()
    reply.status(204)
  })
}
