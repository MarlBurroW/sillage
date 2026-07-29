import type {
  McpServerStatus as CodexMcpServerStatus,
  ThreadStartParams,
} from '@sillage/codex-bindings/v2'
import type { McpServer, McpServerState, McpServerStatus } from '@sillage/protocol'

/**
 * Traduction du registre Sillage vers la configuration que Codex accepte, et retour.
 *
 * Codex ne lit les serveurs MCP que depuis sa configuration : il n'a pas d'équivalent
 * de `setMcpServers`. Sillage les pose en surcharge de thread plutôt que d'écrire dans
 * `~/.codex/config.toml`, ce qui laisse le fichier de l'utilisateur intact et rend
 * l'activation par conversation possible.
 */

/** Serveur MCP intégré à Codex, présent dans tout thread sans que personne l'ait déclaré. */
const BUILTIN_SERVERS = new Set(['codex_apps'])

type ThreadConfig = NonNullable<ThreadStartParams['config']>
type ConfigValue = NonNullable<ThreadConfig[string]>

/**
 * Surcharges à passer dans `config` de `thread/start` et `thread/resume`.
 *
 * Toujours renseigné, même vide : l'absence de clé et une table vide se valent ici, et
 * un objet inconditionnel évite d'avoir à distinguer les deux au point d'appel.
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
    // Codex ne distingue pas `http` de `sse` en configuration : il déduit le transport
    // de la présence d'une URL.
    return [server.name, { url: transport.url, http_headers: transport.headers }]
  })

  return { mcp_servers: Object.fromEntries(entries) }
}

/**
 * Codex décrit un serveur par deux axes que Claude fond en un seul : un état de
 * démarrage et un état d'authentification. L'authentification manquante l'emporte,
 * étant la seule que l'utilisateur peut corriger lui-même.
 */
const STARTUP_STATES: Record<string, McpServerState> = {
  starting: 'pending',
  ready: 'connected',
  failed: 'failed',
  /** Démarrage abandonné : le serveur n'est pas là, et pas davantage en route. */
  cancelled: 'failed',
}

/** Dernier démarrage annoncé par `mcpServer/startupStatus/updated`, par serveur. */
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
    // Le serveur figure dans l'inventaire sans annonce de démarrage : il est en place
    // depuis avant que Sillage n'écoute. `connected` plutôt que `pending`, qui
    // laisserait un serveur fonctionnel affiché comme en cours de lancement.
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
