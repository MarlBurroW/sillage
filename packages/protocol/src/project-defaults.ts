import { z } from 'zod'
import {
  agentConfigSchema,
  claudeConfigSchema,
  codexConfigSchema,
  type ClaudeConfig,
  type CodexConfig,
} from './agent-config.js'

/**
 * Préréglages d'un projet : avec quoi ses conversations s'ouvrent, avant les défauts
 * du compte.
 *
 * Réglage partagé et non personnel, à la différence de `AgentDefaults` : il décrit le
 * projet, pas celui qui le lit. Les serveurs MCP utiles à un dépôt le sont pour tout
 * le monde, et les répertoires supplémentaires — retirés des défauts de compte parce
 * qu'ils désignent des dossiers précis — retrouvent ici le seul endroit où ils ont un
 * sens. Seul le propriétaire du projet peut les écrire.
 *
 * Un préréglage par CLI, comme pour le compte, et pour la même raison : les garde-fous
 * de Claude et ceux de Codex ne se traduisent pas les uns dans les autres. `null`
 * signifie « ce projet ne dit rien de ce CLI », et les défauts du compte reprennent la
 * main — ce n'est pas la même chose qu'un préréglage vide.
 */
export interface ProjectAgentDefaults {
  claude: ClaudeConfig | null
  codex: CodexConfig | null
}

export const NO_PROJECT_DEFAULTS: ProjectAgentDefaults = { claude: null, codex: null }

/**
 * Tolérant comme celui des réglages de compte : un CLI dont la configuration a dérivé
 * du protocole retombe sur « rien de dit », plutôt que de rendre le projet illisible.
 */
export const projectAgentDefaultsSchema = z
  .object({
    claude: claudeConfigSchema.nullable().default(null).catch(null),
    codex: codexConfigSchema.nullable().default(null).catch(null),
  })
  .catch(NO_PROJECT_DEFAULTS)

/**
 * Relit la colonne `projects.default_config`.
 *
 * La forme d'avant les préréglages par CLI y est encore possible : une configuration
 * seule, sans le CLI en clé. Elle se range sous le CLI que porte son discriminant,
 * plutôt que d'être silencieusement perdue à la première lecture.
 */
export function readProjectDefaults(raw: string | null | undefined): ProjectAgentDefaults {
  if (!raw) return NO_PROJECT_DEFAULTS

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return NO_PROJECT_DEFAULTS
  }

  const legacy = agentConfigSchema.safeParse(parsed)
  if (legacy.success) return { ...NO_PROJECT_DEFAULTS, [legacy.data.agent]: legacy.data }

  return projectAgentDefaultsSchema.parse(parsed)
}

/**
 * Ce qui doit être écrit en colonne pour un préréglage remplacé.
 *
 * `null` quand plus aucun CLI n'a de préréglage : la colonne retrouve son état de
 * projet neuf, et rien ne distingue « vidé » de « jamais réglé ».
 */
export function serializeProjectDefaults(defaults: ProjectAgentDefaults): string | null {
  if (!defaults.claude && !defaults.codex) return null
  return JSON.stringify(defaults)
}
