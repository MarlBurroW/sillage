import { inArray } from 'drizzle-orm'
import { mcpServers, type Db, type McpServerRow } from '@sillage/db'
import {
  applySecrets,
  mcpTransportSchema,
  type McpServer,
  type McpServerStatus,
} from '@sillage/protocol'
import type { SecretStore } from '../secrets/store.js'

/**
 * Lecture du registre MCP pour le compte des runners.
 *
 * Les conversations ne stockent que des identifiants : un serveur renommé ou
 * reconfiguré vaut pour toutes celles qui l'utilisent, sans réécrire leur config.
 * Le revers est qu'un identifiant peut désigner un serveur supprimé, cas traité ici
 * plutôt que dans chaque runner.
 *
 * C'est aussi ici que les `{{secret.NOM}}` sont remplacés. La substitution ne se fait
 * qu'au dernier moment, dans le process qui lance le CLI : les valeurs déchiffrées ne
 * sont jamais écrites en base, ne passent pas par le journal et ne remontent pas au
 * navigateur.
 */

export interface ResolvedMcpServers {
  /** Prêts à partir au CLI, secrets substitués. */
  servers: McpServer[]
  /**
   * Écartés faute d'un secret, à afficher en échec dans l'inventaire.
   *
   * Écartés plutôt que transmis avec un en-tête vide : un serveur distant répondrait
   * alors un 401 que rien ne relie au secret manquant, et le diagnostic se ferait à
   * l'aveugle.
   */
  failures: { name: string; error: string }[]
}

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

/** Substitue dans chaque valeur d'une table, en cumulant les secrets introuvables. */
function applyToValues(
  pairs: Record<string, string>,
  resolve: (name: string) => string | undefined,
  missing: Set<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(pairs).map(([key, value]) => {
      const applied = applySecrets(value, resolve)
      for (const name of applied.missing) missing.add(name)
      return [key, applied.text]
    }),
  )
}

function withSecrets(
  server: McpServer,
  resolve: (name: string) => string | undefined,
): { server: McpServer; missing: string[] } {
  const missing = new Set<string>()
  const { transport } = server

  const resolved: McpServer['transport'] =
    transport.type === 'stdio'
      ? { ...transport, env: applyToValues(transport.env, resolve, missing) }
      : { ...transport, headers: applyToValues(transport.headers, resolve, missing) }

  return { server: { ...server, transport: resolved }, missing: [...missing] }
}

/**
 * Serveurs à transmettre au CLI pour une conversation.
 *
 * Silencieux sur les identifiants inconnus et sur les serveurs désactivés : ce sont des
 * états normaux, pas des erreurs. Une conversation qui référence un serveur supprimé
 * doit démarrer, pas échouer, sans quoi supprimer une entrée du registre casserait
 * toutes les conversations qui s'en servaient.
 */
export function resolveMcpServers(
  db: Db,
  store: SecretStore,
  ids: string[],
): ResolvedMcpServers {
  if (ids.length === 0) return { servers: [], failures: [] }

  const rows = db.select().from(mcpServers).where(inArray(mcpServers.id, ids)).all()
  const byId = new Map(rows.map((row) => [row.id, row]))

  const servers: McpServer[] = []
  const failures: ResolvedMcpServers['failures'] = []

  // Ordonné selon la configuration, pas selon la base : deux serveurs qui exposent un
  // outil de même nom se départagent par cet ordre, qui doit rester celui que
  // l'utilisateur a choisi.
  for (const id of ids) {
    const row = byId.get(id)
    if (!row || !row.enabled) continue

    const applied = withSecrets(rowToMcpServer(row), (name) => store.resolve(name))
    if (applied.missing.length > 0) {
      failures.push({
        name: row.name,
        error: `Missing secret: ${applied.missing.join(', ')}`,
      })
      continue
    }
    servers.push(applied.server)
  }

  return { servers, failures }
}

/**
 * Serveurs écartés, sous la forme que l'inventaire attend.
 *
 * `external: false` : ce sont bien des serveurs de Sillage, c'est justement pour ça
 * qu'ils doivent se corriger depuis l'écran des secrets.
 */
export function failedStatuses(failures: ResolvedMcpServers['failures']): McpServerStatus[] {
  return failures.map((failure) => ({
    name: failure.name,
    state: 'failed' as const,
    tools: [],
    error: failure.error,
    external: false,
  }))
}

/** Secrets référencés par une entrée du registre, pour dire où un secret sert. */
export function secretsUsedBy(row: McpServerRow): string[] {
  const transport = mcpTransportSchema.parse(JSON.parse(row.transport))
  const values = transport.type === 'stdio' ? transport.env : transport.headers

  const used = new Set<string>()
  for (const value of Object.values(values)) {
    // La substitution sert ici de lecteur : elle rend les noms non résolus, ce qui est
    // exactement la liste cherchée quand rien n'est résolu.
    for (const name of applySecrets(value, () => undefined).missing) used.add(name)
  }
  return [...used]
}
