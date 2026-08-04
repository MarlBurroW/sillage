import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BUILTIN_MCP_SERVER_NAME, type AgentConfig, type McpServer } from '@sillage/protocol'

/**
 * Le serveur MCP de Sillage, monté d'office dans chaque conversation.
 *
 * Ce n'est pas une ligne de `mcp_servers` : personne ne l'a déclaré, il n'a ni commande
 * à saisir ni secret à garder, et son nom est réservé pour qu'aucune entrée du registre
 * ne vienne l'écraser. Il emprunte quand même la forme `McpServer`, ce qui lui fait
 * traverser les deux adaptateurs de CLI et l'inventaire sans qu'aucun d'eux ait à
 * connaître son existence.
 *
 * Activé par défaut, désactivable à trois niveaux : la conversation, pour le temps d'un
 * sujet ; le défaut des nouvelles conversations, dans les réglages ; l'instance entière,
 * dans `config.toml`, pour qui ne veut de Sillage qu'une interface aux CLI.
 */

/** Identifiant distinct de ceux du registre, qui sont des UUID. */
export const BUILTIN_MCP_SERVER_ID = 'builtin:sillage'

/**
 * Le fichier du serveur, selon qu'on tourne sur les sources ou sur le bundle.
 *
 * En développement ce module est `src/agents/mcp-builtin.ts` et le serveur son voisin
 * `src/mcp/` ; en production tsup a tout fondu dans `dist/main.js` et le `.mjs` est
 * copié dans `dist/mcp/`. Deux candidats testés plutôt qu'un drapeau d'environnement,
 * qui mentirait le jour où quelqu'un lance le bundle depuis le dépôt.
 */
function resolveEntry(): string {
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
  /** Interrupteur global de `config.toml`. */
  enabled: boolean
  config: AgentConfig
  databasePath: string
  projectId: string
  conversationId: string
}

/**
 * Null quand le serveur ne doit pas partir, pour l'une des raisons du contrat ci-dessus.
 *
 * `strictMcp` l'emporte sur l'activation : le drapeau annonce « rien d'autre que ce que
 * j'ai déclaré » et se contredirait à garder une exception maison.
 */
export function builtinMcpEnabled(enabled: boolean, config: AgentConfig): boolean {
  if (!enabled || !config.sillageMcp) return false
  return !(config.agent === 'claude' && config.strictMcp)
}

export function builtinMcpServer(params: BuiltinMcpParams): McpServer | null {
  const { enabled, config, databasePath, projectId, conversationId } = params
  if (!builtinMcpEnabled(enabled, config)) return null

  return {
    id: BUILTIN_MCP_SERVER_ID,
    name: BUILTIN_MCP_SERVER_NAME,
    enabled: true,
    transport: {
      type: 'stdio',
      // `process.execPath` et non « node » : sous systemd le PATH est minimal, et rien
      // ne garantit que celui du CLI mène au même runtime que celui du serveur.
      command: process.execPath,
      args: [resolveEntry()],
      // Une portée, jamais un secret : le serveur lit la base directement, il n'a donc
      // aucun jeton à recevoir, et l'environnement d'un process reste lisible par
      // quiconque a un shell sur la machine.
      env: {
        SILLAGE_MCP_DB: databasePath,
        SILLAGE_MCP_PROJECT: projectId,
        SILLAGE_MCP_CONVERSATION: conversationId,
      },
    },
    createdAt: 0,
    updatedAt: 0,
  }
}
