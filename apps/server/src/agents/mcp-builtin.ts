import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BUILTIN_MCP_SERVER_NAME, type AgentConfig, type McpServer } from '@sillage/protocol'

/** Built-in Sillage MCP server mounted in conversations. Not a `mcp_servers` row: no user-declared command or secret, with reserved names preventing registry overrides. Still uses `McpServer` to pass adapters/inventory without special knowledge. Enabled by default; disable per conversation, default settings or instance `config.toml` for users wanting CLI interfaces only. */

/** ID distinct from registry UUIDs. */
export const BUILTIN_MCP_SERVER_ID = 'builtin:sillage'

/** Server file under source or bundle layouts. Development `src/agents/mcp-builtin.ts` finds neighboring `src/mcp/`; production bundles to `dist/main.js` and copies `.mjs` to `dist/mcp/`. Test both candidates rather than environment flags, which mislead when bundles run from repositories. */
export function resolveEntry(): string {
  const candidates = [
    join(import.meta.dirname, '../mcp/sillage-mcp.mjs'),
    join(import.meta.dirname, 'mcp/sillage-mcp.mjs'),
  ]
  const found = candidates.find((path) => existsSync(path))
  if (!found) {
    throw new Error(`Serveur MCP Sillage introuvable (cherché : ${candidates.join(', ')})`)
  }
  return found
}

export interface BuiltinMcpParams {
  /** Global config.toml switch. */
  enabled: boolean
  config: AgentConfig
  databasePath: string
  projectId: string
  conversationId: string
  /** Project memory directory where Codex `write_memory` writes. */
  /** Null in native mode, omitting memory tools. */
  memoryDir: string | null
}

/** Null when disabled according to the contract above. `strictMcp` overrides activation: promising only declared servers cannot retain platform exceptions. */
export function builtinMcpEnabled(enabled: boolean, config: AgentConfig): boolean {
  if (!enabled || !config.sillageMcp) return false
  return !(config.agent === 'claude' && config.strictMcp)
}

export function builtinMcpServer(params: BuiltinMcpParams): McpServer | null {
  const { enabled, config, databasePath, projectId, conversationId, memoryDir } = params
  if (!builtinMcpEnabled(enabled, config)) return null

  return {
    id: BUILTIN_MCP_SERVER_ID,
    name: BUILTIN_MCP_SERVER_NAME,
    enabled: true,
    transport: {
      type: 'stdio',
      // Use process.execPath rather than node: systemd has a minimal PATH and nothing
      // guarantees the CLI's Node matches the server runtime.
      command: process.execPath,
      args: [resolveEntry()],
      // Scope only, never secrets: direct database reads need no tokens,
      // and process environments remain readable
      // to anyone with machine shell access.
      env: {
        SILLAGE_MCP_DB: databasePath,
        SILLAGE_MCP_PROJECT: projectId,
        SILLAGE_MCP_CONVERSATION: conversationId,
        ...(memoryDir ? { SILLAGE_MCP_MEMORY: memoryDir } : {}),
      },
    },
    createdAt: 0,
    updatedAt: 0,
  }
}
