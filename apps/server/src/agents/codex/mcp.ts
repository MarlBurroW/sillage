import type {
  McpServerStatus as CodexMcpServerStatus,
  ThreadStartParams,
} from '@sillage/codex-bindings/v2'
import type { McpServer, McpServerState, McpServerStatus } from '@sillage/protocol'

/**
 * Translate Sillage registry to Codex configuration and back. Codex reads MCP only through
 * configuration without setMcpServers. Apply thread overrides rather than writing user config.toml,
 * preserving their file and supporting per-conversation activation.
 */

/** Built-in Codex MCP server present in every thread without explicit declaration. */
const BUILTIN_SERVERS = new Set(['codex_apps'])

type ThreadConfig = NonNullable<ThreadStartParams['config']>
type ConfigValue = NonNullable<ThreadConfig[string]>

/**
 * Overrides for config in thread/start and thread/resume. Always supply even when empty: missing
 * keys and empty tables are equivalent, while unconditional objects avoid call-site branching.
 */
export function toCodexThreadConfig(servers: McpServer[]): ThreadConfig {
  const entries = servers.map((server): [string, ConfigValue] => {
    const { transport } = server
    if (transport.type === 'stdio') {
      return [
        server.name,
        { command: transport.command, args: transport.args, env: transport.env },
      ]
    }
    // Codex does not distinguish HTTP and SSE configuration; it infers transport
    // from URL presence.
    return [server.name, { url: transport.url, http_headers: transport.headers }]
  })

  return { mcp_servers: Object.fromEntries(entries) }
}

/**
 * Codex separates startup and authentication states that Claude combines. Missing authentication
 * takes precedence because users can directly fix it.
 */
const STARTUP_STATES: Record<string, McpServerState> = {
  starting: 'pending',
  ready: 'connected',
  failed: 'failed',
  /** Abandoned startup: the server is neither present nor still starting. */
  cancelled: 'failed',
}

/** Latest startup status per server from mcpServer/startupStatus/updated. */
export interface CodexMcpStartup {
  status: string
  error: string | null
}

export function fromCodexMcpStatus(
  statuses: CodexMcpServerStatus[],
  declared: McpServer[],
  startup: Map<string, CodexMcpStartup>,
): McpServerStatus[] {
  const ours = new Set(declared.map((server) => server.name))

  return statuses.map((status) => {
    const latest = startup.get(status.name)
    // Inventory entries without startup announcements were already running
    // before Sillage subscribed. Use connected rather than pending, which would
    // leave functioning servers displayed as starting.
    const state = status.authStatus === 'notLoggedIn'
      ? 'needs-auth'
      : (latest ? (STARTUP_STATES[latest.status] ?? 'pending') : 'connected')

    return {
      name: status.name,
      state,
      tools: Object.keys(status.tools ?? {}),
      error: latest?.error ?? null,
      external: !ours.has(status.name) || BUILTIN_SERVERS.has(status.name),
    }
  })
}
