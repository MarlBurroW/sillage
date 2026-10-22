import { join } from 'node:path'
import type { Config, MCPStatus, PermissionConfig } from '@sillage/opencode-bindings'
import type { McpServer, McpServerState, McpServerStatus, OpencodeConfig } from '@sillage/protocol'

/**
 * Translate conversation config to opencode.
 *
 * opencode reads permissions/MCP/skill paths at launch, not per session. Inject
 * OPENCODE_CONFIG_CONTENT merged over user opencode.json without touching it. Changes restart
 * server; sameLaunchConfig decides.
 */

export interface LaunchInputs {
  config: OpencodeConfig
  mcpServers: McpServer[]
  /** Library plugin roots; skills under skills/. */
  skillRoots: string[]
  /** Outside-cwd directories agent may read without asking. */
  readableDirs: string[]
}

type McpEntry = NonNullable<Config['mcp']>[string]

function toMcpEntry(server: McpServer): McpEntry {
  const { transport } = server
  if (transport.type === 'stdio') {
    return {
      type: 'local',
      command: [transport.command, ...transport.args],
      environment: transport.env,
      enabled: true,
    }
  }
  // opencode tries http then sse rather than distinguishing them. Disable oauth to avoid discovery
  // when Sillage already provides headers.
  return { type: 'remote', url: transport.url, headers: transport.headers, oauth: false, enabled: true }
}

/**
 * Sillage rules. Omit CLI_DEFAULT families so machine rules survive merge.
 *
 * external_directory gets precise patterns, never *: machine default still asks outside cwd;
 * Sillage opens only its own supplied directories.
 */
function toPermission({ config, skillRoots, readableDirs }: LaunchInputs): PermissionConfig {
  const { edit, bash, webfetch } = config.permissions
  const external = [...config.additionalDirectories, ...skillRoots, ...readableDirs]

  return {
    ...(edit ? { edit } : {}),
    ...(bash ? { bash } : {}),
    ...(webfetch ? { webfetch } : {}),
    ...(external.length > 0
      ? { external_directory: Object.fromEntries(external.map((dir) => [join(dir, '**'), 'allow' as const])) }
      : {}),
  }
}

export function toOpencodeConfig(inputs: LaunchInputs): Config {
  return {
    // Per-conversation servers must neither self-update nor publish.
    autoupdate: false,
    share: 'disabled',
    permission: toPermission(inputs),
    mcp: Object.fromEntries(inputs.mcpServers.map((server) => [server.name, toMcpEntry(server)])),
    ...(inputs.skillRoots.length > 0
      ? { skills: { paths: inputs.skillRoots.map((root) => join(root, 'skills')) } }
      : {}),
  }
}

/** Equivalent launch configurations do not warrant restart. */
export function sameLaunchConfig(a: Config, b: Config): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const MCP_STATES: Record<MCPStatus['status'], McpServerState> = {
  connected: 'connected',
  disabled: 'disabled',
  failed: 'failed',
  needs_auth: 'needs-auth',
  needs_client_registration: 'needs-auth',
}

/**
 * GET /mcp inventory. opencode omits individual tools: keep empty list instead of guessing name
 * prefixes.
 */
export function fromOpencodeMcpStatus(
  statuses: Record<string, MCPStatus>,
  declared: McpServer[],
): McpServerStatus[] {
  const ours = new Set(declared.map((server) => server.name))
  return Object.entries(statuses).map(([name, status]) => ({
    name,
    state: MCP_STATES[status.status] ?? 'pending',
    tools: [],
    error: 'error' in status && typeof status.error === 'string' ? status.error : null,
    external: !ours.has(name),
  }))
}
