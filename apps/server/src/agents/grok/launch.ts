import type { GrokConfig, McpServer } from '@sillage/protocol'
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk'

/**
 * Comment Sillage lance `grok agent stdio`, et dans quel environnement.
 *
 * Tout ce qui est affirmé ici a été sondé sur Grok Build 1.0.62.
 */

/**
 * Grok lit d'office la configuration de Claude Code et de Cursor : leurs consignes, leurs
 * skills, leurs serveurs MCP, leurs hooks et leurs agents. Pour une session de Sillage,
 * c'est doublement faux. Les consignes arrivent déjà par SILLAGE.md, et le serveur MCP
 * `sillage` serait monté deux fois. Surtout, Grok republie dans le flux ACP
 * (`_x.ai/mcp/servers_updated`) l'environnement des serveurs qu'il a trouvés, jetons
 * compris : les secrets du `~/.claude.json` de l'utilisateur finiraient dans le journal.
 * La mise à jour automatique est coupée : c'est Sillage qui choisit la version, comme
 * pour les autres CLI.
 */
export const GROK_ISOLATION_ENV: Record<string, string> = {
  // Tout reste sur la machine : pas de télémétrie, de rapport d'erreur ni d'envoi des
  // traces de session, que des réglages distants de xAI peuvent sinon allumer, et pas
  // de synchronisation de l'historique vers le compte.
  GROK_TELEMETRY_ENABLED: 'false',
  GROK_ERROR_REPORTING: 'false',
  GROK_TELEMETRY_TRACE_UPLOAD: 'false',
  GROK_STORAGE_MODE: 'local',
  // Un dossier qui porte des consignes ou des serveurs MCP et que personne n'a déclaré
  // de confiance voit ces fichiers ignorés en silence en ACP, faute d'invite. Le projet
  // a été ouvert dans Sillage par son propriétaire : c'est la confiance qui compte.
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

/** Ce qui se décide au lancement du process, et qu'un changement oblige à relancer. */
export interface GrokLaunch {
  args: string[]
  env: Record<string, string>
}

export function grokLaunch(config: GrokConfig, pluginDirs: string[]): GrokLaunch {
  // Les options de session de Grok (`--disable-web-search`…) se placent avant la
  // sous-commande : `grok agent` refuse ce qu'il ne déclare pas lui-même.
  const args = config.webSearch ? [] : ['--disable-web-search']
  // `--no-leader` : un process à soi, sans le serveur partagé que `grok` lance d'office
  // pour ses clients, et qui ignorerait `--plugin-dir`.
  args.push('agent', '--no-leader')
  for (const dir of pluginDirs) args.push('--plugin-dir', dir)
  args.push('stdio')
  return { args, env: { ...GROK_ISOLATION_ENV } }
}

export function sameLaunch(a: GrokLaunch, b: GrokLaunch): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Un serveur du registre dans la forme de l'ACP : l'environnement et les en-têtes y
 * sont des listes de paires, pas des tables.
 */
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
