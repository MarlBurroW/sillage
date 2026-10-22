import { inArray } from 'drizzle-orm'
import { mcpServers, type Db, type McpServerRow } from '@sillage/db'
import {
  applySecrets,
  mcpTransportSchema,
  type McpServer,
  type McpServerStatus,
} from '@sillage/protocol'
import type { SecretStore } from '../secrets/store.js'

/** Runner MCP registry reads. Conversations retain IDs, so renaming/reconfiguration applies globally without rewriting settings; handle deleted IDs here instead of per runner. Substitute `{{secret.NOM}}` only immediately before CLI launch: decrypted values never enter databases, journals or browsers. */

export interface ResolvedMcpServers {
  /** Ready for CLIs with secrets substituted. */
  servers: McpServer[]
  /** Servers excluded for missing secrets, displayed failed in inventory. Exclude rather than transmit empty headers, which would produce unexplained remote 401 errors and obscure diagnosis. */
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

/** Substitutes all map values while collecting missing secrets. */
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

/** Conversation servers delivered to CLIs. Silently ignore unknown IDs and disabled servers as normal states: deleting registry entries must not break referencing conversations. */
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

  // Order by configuration rather than database: duplicate tool names resolve
  // according to the order
  // chosen by the user.
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

/** Excluded servers in inventory form. `external: false` because these belong to Sillage and must be fixed through Secrets settings. */
export function failedStatuses(failures: ResolvedMcpServers['failures']): McpServerStatus[] {
  return failures.map((failure) => ({
    name: failure.name,
    state: 'failed' as const,
    tools: [],
    error: failure.error,
    external: false,
  }))
}

/** Secrets referenced by registry entries for usage lookup. */
export function secretsUsedBy(row: McpServerRow): string[] {
  const transport = mcpTransportSchema.parse(JSON.parse(row.transport))
  const values = transport.type === 'stdio' ? transport.env : transport.headers

  const used = new Set<string>()
  for (const value of Object.values(values)) {
    // Use substitution as a reader: unresolved names are precisely the desired list
    // when nothing resolves.
    for (const name of applySecrets(value, () => undefined).missing) used.add(name)
  }
  return [...used]
}
