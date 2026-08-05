import { z } from 'zod'
import {
  agentConfigSchema,
  claudeConfigSchema,
  codexConfigSchema,
  DEFAULT_CLAUDE_CONFIG,
  DEFAULT_CODEX_CONFIG,
  type ClaudeConfig,
  type CodexConfig,
} from './agent-config.js'

/**
 * Réglages propres à un compte, par opposition à ceux de l'instance.
 *
 * Ils ne décrivent pas un comportement du serveur mais un point de départ : avec quoi
 * une conversation s'ouvre quand personne n'a rien dit d'autre. Deux personnes du même
 * projet peuvent donc ne pas travailler avec les mêmes garde-fous, ce qui est le but :
 * le mode de permission engage celui qui lit les réponses, pas l'instance.
 */
export interface UserSettingsDto {
  agentDefaults: AgentDefaults
}

/**
 * Un défaut complet par CLI, jamais un défaut commun.
 *
 * Même raison que pour `AgentConfig` : le mode de permission de Claude et le couple
 * approbation/sandbox de Codex ne se traduisent pas l'un dans l'autre, et un réglage
 * unique aurait à inventer cette traduction.
 */
export interface AgentDefaults {
  claude: ClaudeConfig
  codex: CodexConfig
}

export const DEFAULT_AGENT_DEFAULTS: AgentDefaults = {
  claude: DEFAULT_CLAUDE_CONFIG,
  codex: DEFAULT_CODEX_CONFIG,
}

/**
 * Relit ce qui est stocké pour un compte.
 *
 * Tolérant à chaque étage : un réglage ajouté depuis l'écriture, une valeur retirée du
 * protocole ou un enregistrement à moitié écrit retombent sur le défaut du CLI plutôt
 * que de rendre l'écran de réglages illisible. C'est un point de départ de
 * conversation, rien ici ne mérite une erreur.
 */
export const agentDefaultsSchema = z.object({
  claude: claudeConfigSchema.catch(DEFAULT_CLAUDE_CONFIG),
  codex: codexConfigSchema.catch(DEFAULT_CODEX_CONFIG),
})

export const storedUserSettingsSchema = z
  .object({ agentDefaults: agentDefaultsSchema.catch(DEFAULT_AGENT_DEFAULTS) })
  .catch({ agentDefaults: DEFAULT_AGENT_DEFAULTS })

export const updateUserSettingsBodySchema = z.object({
  /**
   * Le défaut d'un seul CLI, le discriminant de la configuration disant lequel. Celui
   * de l'autre CLI garde sa valeur : l'écran n'édite qu'un CLI à la fois, et envoyer
   * les deux écraserait celui qu'un autre onglet vient peut-être de changer.
   */
  agentDefault: agentConfigSchema,
})
