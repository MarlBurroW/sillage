import { CLI_DEFAULT, type AgentConfig } from '@sillage/protocol'
import type { Config } from '../config.js'
import { ClaudeModelCatalog } from './claude/model-catalog.js'
import { ClaudeUsageReader } from './claude/usage.js'
import { CodexModelCatalog } from './codex/model-catalog.js'
import { CodexUsageReader } from './codex/usage.js'

/**
 * Catalogues des deux CLI, partagés par les routes et par la création de conversation.
 * Un seul exemplaire par daemon : chaque catalogue démarre un process CLI pour se
 * remplir, ce qu'on ne veut pas faire deux fois.
 */
export class AgentCatalogs {
  readonly claude = new ClaudeModelCatalog()
  readonly codex: CodexModelCatalog
  /**
   * Lecteurs de quota, à part des catalogues : les modèles ne bougent qu'entre deux
   * versions de CLI, la consommation change en permanence. Deux durées de cache
   * différentes, donc deux objets.
   */
  readonly claudeUsage = new ClaudeUsageReader()
  readonly codexUsage: CodexUsageReader

  constructor(config: Config) {
    this.codex = new CodexModelCatalog(config.agents.codex.binary)
    this.codexUsage = new CodexUsageReader(config.agents.codex.binary)
  }

  /**
   * Remplace les `CLI_DEFAULT` par ce que le CLI annonce réellement. Si le catalogue
   * est injoignable on laisse la valeur vide : le CLI appliquera alors son propre
   * défaut au lancement, ce qui reste juste. Inventer un identifiant ici produirait
   * une conversation qui échoue plus tard, sans rapport visible avec la cause.
   */
  async resolveDefaults(config: AgentConfig): Promise<AgentConfig> {
    if (config.agent === 'claude') {
      if (config.model !== CLI_DEFAULT) return config
      const { models } = await this.claude.list().catch(() => ({ models: [] }))
      const fallback = models.find((model) => model.value === 'default') ?? models[0]
      return fallback ? { ...config, model: fallback.value } : config
    }

    if (config.model !== CLI_DEFAULT && config.reasoningEffort !== CLI_DEFAULT) return config

    const { models } = await this.codex.list().catch(() => ({ models: [] }))
    const chosen =
      models.find((model) => model.model === config.model) ??
      models.find((model) => model.isDefault) ??
      models[0]
    if (!chosen) return config

    return {
      ...config,
      model: config.model === CLI_DEFAULT ? chosen.model : config.model,
      reasoningEffort:
        config.reasoningEffort === CLI_DEFAULT
          ? chosen.defaultReasoningEffort
          : config.reasoningEffort,
    }
  }
}
