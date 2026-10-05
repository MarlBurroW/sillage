import { join } from 'node:path'
import type { Config, MCPStatus, PermissionConfig } from '@sillage/opencode-bindings'
import type { McpServer, McpServerState, McpServerStatus, OpencodeConfig } from '@sillage/protocol'

/**
 * Traduction d'une configuration de conversation vers celle d'opencode.
 *
 * opencode ne règle rien par session : permissions, serveurs MCP et dossiers de skills
 * se lisent dans sa configuration, au lancement. Sillage les pose donc dans
 * `OPENCODE_CONFIG_CONTENT`, qui se fusionne par-dessus l'`opencode.json` de
 * l'utilisateur sans y toucher. La contrepartie est qu'en changer relance le serveur,
 * ce que `sameLaunchConfig` sert à décider.
 */

export interface LaunchInputs {
  config: OpencodeConfig
  mcpServers: McpServer[]
  /** Racines de plugin de la bibliothèque de skills ; leurs skills sont sous `skills/`. */
  skillRoots: string[]
  /** Dossiers hors du répertoire de travail que l'agent lit sans demander. */
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
  // opencode ne distingue pas `http` de `sse` : il essaie l'un puis l'autre. `oauth`
  // coupé, sans quoi il tente une découverte OAuth sur un serveur dont Sillage fournit
  // déjà les en-têtes.
  return { type: 'remote', url: transport.url, headers: transport.headers, oauth: false, enabled: true }
}

/**
 * Les règles posées par Sillage. Une famille en `CLI_DEFAULT` est omise : la fusion
 * laisse alors parler la règle du poste.
 *
 * `external_directory` ne reçoit que des motifs précis, jamais de `*` : la règle
 * générale d'opencode (demander hors du répertoire de travail) reste celle du poste,
 * Sillage n'ouvre que ce qu'il fournit lui-même.
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
    // Un serveur par conversation ne doit ni se mettre à jour tout seul ni publier.
    autoupdate: false,
    share: 'disabled',
    permission: toPermission(inputs),
    mcp: Object.fromEntries(inputs.mcpServers.map((server) => [server.name, toMcpEntry(server)])),
    ...(inputs.skillRoots.length > 0
      ? { skills: { paths: inputs.skillRoots.map((root) => join(root, 'skills')) } }
      : {}),
  }
}

/** Deux configurations qui donnent le même lancement ne justifient pas de relancer. */
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
 * Inventaire MCP tel qu'opencode le rend sur `GET /mcp`. Il n'annonce pas les outils de
 * chaque serveur : la liste reste vide plutôt que devinée d'après les préfixes de noms.
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
