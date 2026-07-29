import { inArray } from 'drizzle-orm'
import { mcpServers, type Db, type McpServerRow } from '@sillage/db'
import { mcpTransportSchema, type McpServer } from '@sillage/protocol'

/**
 * Lecture du registre MCP pour le compte des runners.
 *
 * Les conversations ne stockent que des identifiants : un serveur renommé ou
 * reconfiguré vaut pour toutes celles qui l'utilisent, sans réécrire leur config.
 * Le revers est qu'un identifiant peut désigner un serveur supprimé, cas traité ici
 * plutôt que dans chaque runner.
 */

export function rowToMcpServer(row: McpServerRow): McpServer {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    transport: mcpTransportSchema.parse(JSON.parse(row.transport)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Serveurs à transmettre au CLI pour une conversation.
 *
 * Silencieux sur les identifiants inconnus et sur les serveurs désactivés : ce sont des
 * états normaux, pas des erreurs. Une conversation qui référence un serveur supprimé
 * doit démarrer, pas échouer, sans quoi supprimer une entrée du registre casserait
 * toutes les conversations qui s'en servaient.
 */
export function resolveMcpServers(db: Db, ids: string[]): McpServer[] {
  if (ids.length === 0) return []

  const rows = db.select().from(mcpServers).where(inArray(mcpServers.id, ids)).all()
  const byId = new Map(rows.map((row) => [row.id, row]))

  // Ordonné selon la configuration, pas selon la base : deux serveurs qui exposent un
  // outil de même nom se départagent par cet ordre, qui doit rester celui que
  // l'utilisateur a choisi.
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is McpServerRow => row !== undefined && row.enabled)
    .map(rowToMcpServer)
}
