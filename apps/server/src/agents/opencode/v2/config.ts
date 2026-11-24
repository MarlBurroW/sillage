import { join } from 'node:path'
import type { McpServer as NativeMcpServer, PermissionRule } from '@sillage/opencode-bindings/v2'
import type { McpServer, McpServerState, McpServerStatus } from '@sillage/protocol'
import type { LaunchInputs } from '../config.js'

/**
 * OpenCode 2 launch configuration, in its native document format.
 *
 * 2.x still accepts the 1.x document in OPENCODE_CONFIG_CONTENT and translates it (probed 2.4.1:
 * `autoupdate` → `update`, `permission` → `permissions` rules, `bash` → `shell`, `mcp` →
 * `mcp.servers`). Writing the 2.x shape avoids depending on that compatibility layer, and is the
 * only way to set `codemode`.
 */
export interface Opencode2Config {
  update: 'disable'
  share: 'disabled'
  permissions: PermissionRule[]
  mcp: { servers: Record<string, Record<string, unknown>> }
  skills?: string[]
}

function toMcpEntry(server: McpServer): Record<string, unknown> {
  const { transport } = server
  // 2.x hides MCP tools behind a single `execute` tool running model-written JavaScript ("Code
  // Mode"). Direct calls keep Sillage's MCP tools readable in the thread and subject to their
  // own permissions (probed 2.4.1: `<server>_<tool>` instead of `execute`).
  const base = { disabled: false, codemode: false }
  if (transport.type === 'stdio') {
    return { type: 'local', command: [transport.command, ...transport.args], environment: transport.env, ...base }
  }
  return { type: 'remote', url: transport.url, headers: transport.headers, oauth: false, ...base }
}

function toPermissions({ config, skillRoots, readableDirs }: LaunchInputs): PermissionRule[] {
  const { edit, bash, webfetch } = config.permissions
  const external = [...config.additionalDirectories, ...skillRoots, ...readableDirs]
  return [
    ...(edit ? [{ action: 'edit', resource: '*', effect: edit }] : []),
    ...(bash ? [{ action: 'shell', resource: '*', effect: bash }] : []),
    ...(webfetch ? [{ action: 'webfetch', resource: '*', effect: webfetch }] : []),
    ...external.map((dir) => ({ action: 'external_directory', resource: join(dir, '**'), effect: 'allow' as const })),
  ]
}

export function toOpencode2Config(inputs: LaunchInputs): Opencode2Config {
  return {
    // Per-conversation servers must neither self-update nor publish.
    update: 'disable',
    share: 'disabled',
    permissions: toPermissions(inputs),
    mcp: { servers: Object.fromEntries(inputs.mcpServers.map((server) => [server.name, toMcpEntry(server)])) },
    ...(inputs.skillRoots.length > 0 ? { skills: inputs.skillRoots.map((root) => join(root, 'skills')) } : {}),
  }
}

const MCP_STATES: Record<NativeMcpServer['status']['status'], McpServerState> = {
  connected: 'connected',
  pending: 'pending',
  disabled: 'disabled',
  failed: 'failed',
  needs_auth: 'needs-auth',
}

/** GET /api/mcp inventory. Like 1.x, it omits individual tools. */
export function fromOpencode2McpStatus(servers: NativeMcpServer[], declared: McpServer[]): McpServerStatus[] {
  const ours = new Set(declared.map((server) => server.name))
  return servers.map(({ name, status }) => ({
    name,
    state: MCP_STATES[status.status] ?? 'pending',
    tools: [],
    error: 'error' in status ? status.error : null,
    external: !ours.has(name),
  }))
}
