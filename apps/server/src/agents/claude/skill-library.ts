import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk'

/**
 * Ce que la bibliothèque de skills ajoute au lancement de Claude Code.
 *
 * Chaque racine est un plugin local : ses skills deviennent des commandes natives
 * (`/sillage:nom`, alias `/nom`), que le modèle déclenche aussi par leur description.
 * Rien n'est écrit dans `~/.claude`.
 *
 * Trois choses, toutes relevées par sonde :
 * - `skipMcpDiscovery` : un plugin peut déclarer des serveurs MCP, et ceux de Sillage
 *   passent par son registre, pas par là ;
 * - les racines en répertoires autorisés : sans elles, lire un fichier annexe d'un skill
 *   (`references/`, `scripts/`) déclenche une demande de permission ;
 * - des règles `deny` sur `Edit` et `Write` : autoriser un dossier ouvre aussi son
 *   écriture en `acceptEdits`, et l'agent d'un projet pourrait modifier un skill
 *   global que toutes les conversations chargent. C'est un garde-fou contre le geste
 *   involontaire, pas une frontière : une redirection Bash passe toujours. Le `//`
 *   initial désigne un chemin absolu dans la syntaxe des règles de Claude Code.
 */
export interface SkillLibraryLaunchOptions {
  plugins: SdkPluginConfig[]
  additionalDirectories: string[]
  deny: string[]
}

export function skillLibraryLaunchOptions(roots: string[]): SkillLibraryLaunchOptions {
  return {
    plugins: roots.map((path) => ({ type: 'local', path, skipMcpDiscovery: true })),
    additionalDirectories: roots,
    deny: roots.flatMap((root) => [`Edit(/${root}/**)`, `Write(/${root}/**)`]),
  }
}
