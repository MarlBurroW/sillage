import type { McpServerConfig, McpServerStatus as SdkMcpServerStatus } from '@anthropic-ai/claude-agent-sdk'
import type { McpServer, McpServerState, McpServerStatus } from '@sillage/protocol'

/**
 * Traduction du registre Sillage vers ce que le SDK Claude attend, et retour.
 *
 * Les serveurs partent en mémoire, jamais sur le disque : le SDK les annonce ensuite
 * avec `scope: 'dynamic'`, ce qui est aussi le seul moyen de les distinguer de ceux
 * que l'utilisateur a déclarés lui-même dans `~/.claude.json` ou via claude.ai.
 */

const DYNAMIC_SCOPE = 'dynamic'

export function toSdkMcpServers(servers: McpServer[]): Record<string, McpServerConfig> {
  const entries = servers.map((server): [string, McpServerConfig] => {
    const { transport } = server
    if (transport.type === 'stdio') {
      return [
        server.name,
        {
          type: 'stdio',
          command: transport.command,
          args: transport.args,
          env: transport.env,
        },
      ]
    }
    return [
      server.name,
      { type: transport.type, url: transport.url, headers: transport.headers },
    ]
  })
  return Object.fromEntries(entries)
}

/**
 * `pending` par défaut plutôt qu'un état inventé : le SDK documente cinq statuts, mais
 * en ajouter un ne doit pas faire passer un serveur pour connecté.
 */
const STATES: Record<string, McpServerState> = {
  connected: 'connected',
  failed: 'failed',
  'needs-auth': 'needs-auth',
  pending: 'pending',
  disabled: 'disabled',
}

export function fromSdkMcpStatus(statuses: SdkMcpServerStatus[]): McpServerStatus[] {
  return statuses.map((status) => ({
    name: status.name,
    state: STATES[status.status] ?? 'pending',
    tools: (status.tools ?? []).map((tool) => tool.name),
    error: status.error ?? null,
    external: status.scope !== DYNAMIC_SCOPE,
  }))
}
