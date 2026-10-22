import type { GrokConfig, McpServer } from '@sillage/protocol'
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk'

/** How Sillage launches `grok agent stdio` and its environment. All claims probed on Grok Build 1.0.62. */

/** Grok automatically reads Claude Code/Cursor instructions, skills, MCP, hooks and agents. Wrong for Sillage: instructions already arrive through SILLAGE.md and MCP `sillage` would duplicate. Worse, `_x.ai/mcp/servers_updated` exposes discovered server environments including tokens, leaking user `~/.claude.json` secrets into journals. Disable automatic updates too because Sillage selects versions like other CLIs. */
export const GROK_ISOLATION_ENV: Record<string, string> = {
  // Keep everything local: disable telemetry, error reports and session uploads
  // that xAI remote settings might otherwise enable, plus account history sync.
  GROK_TELEMETRY_ENABLED: 'false',
  GROK_ERROR_REPORTING: 'false',
  GROK_TELEMETRY_TRACE_UPLOAD: 'false',
  GROK_STORAGE_MODE: 'local',
  // ACP silently ignores instructions/MCP in untrusted directories because no
  // prompt exists. Project owners opened them in Sillage,
  // which constitutes the relevant trust.
  GROK_FOLDER_TRUST: '0',
  GROK_CLAUDE_RULES_ENABLED: '0',
  GROK_CLAUDE_SKILLS_ENABLED: '0',
  GROK_CLAUDE_MCPS_ENABLED: '0',
  GROK_CLAUDE_HOOKS_ENABLED: '0',
  GROK_CLAUDE_AGENTS_ENABLED: '0',
  GROK_CURSOR_RULES_ENABLED: '0',
  GROK_CURSOR_SKILLS_ENABLED: '0',
  GROK_CURSOR_MCPS_ENABLED: '0',
  GROK_CURSOR_HOOKS_ENABLED: '0',
  GROK_CURSOR_AGENTS_ENABLED: '0',
  GROK_CLAUDE_SESSIONS_ENABLED: '0',
  GROK_CURSOR_SESSIONS_ENABLED: '0',
  GROK_DISABLE_AUTOUPDATER: '1',
}

/** Launch-time choices requiring process restarts when changed. */
export interface GrokLaunch {
  args: string[]
  env: Record<string, string>
}

export function grokLaunch(config: GrokConfig, pluginDirs: string[]): GrokLaunch {
  // Grok session options (`--disable-web-search`…) precede subcommands:
  // `grok agent` rejects undeclared options.
  const args = config.webSearch ? [] : ['--disable-web-search']
  // `--no-leader` gives dedicated processes rather than Grok's default shared
  // server, which would ignore `--plugin-dir`.
  args.push('agent', '--no-leader')
  for (const dir of pluginDirs) args.push('--plugin-dir', dir)
  args.push('stdio')
  return { args, env: { ...GROK_ISOLATION_ENV } }
}

export function sameLaunch(a: GrokLaunch, b: GrokLaunch): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** ACP registry server shape: environments and headers are pair lists rather than maps. */
export function toAcpMcpServer(server: McpServer): AcpMcpServer {
  const { transport } = server
  if (transport.type === 'stdio') {
    return {
      name: server.name,
      command: transport.command,
      args: transport.args,
      env: Object.entries(transport.env).map(([name, value]) => ({ name, value })),
    }
  }
  return {
    type: transport.type,
    name: server.name,
    url: transport.url,
    headers: Object.entries(transport.headers).map(([name, value]) => ({ name, value })),
  }
}
