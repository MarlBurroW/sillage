import type { McpServerConfig, McpServerStatus as SdkMcpServerStatus } from '@anthropic-ai/claude-agent-sdk'
import type { McpServer, McpServerState, McpServerStatus } from '@sillage/protocol'

/** Sillage registry to Claude SDK translation and back. Pass servers in memory, never disk. SDK labels them `scope: 'dynamic'`, distinguishing them from user `~/.claude.json` or claude.ai servers. */

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

/** Default `pending` rather than invented states: future statuses beyond five documented ones must not imply connections. */
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
