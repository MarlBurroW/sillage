import { homedir } from 'node:os'
import type { AccountInfo, ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { CachedProbe } from '../cached-probe.js'
import { withControlSession } from './control-session.js'

/**
 * Catalogue Claude : modèles et compte, lus depuis le CLI installé plutôt que codés
 * en dur.
 *
 * `supportedModels()` et `accountInfo()` sont des requêtes de contrôle (voir
 * `withControlSession`) : aucun message n'est envoyé, donc ni tokens ni quota
 * consommés. Le process coûte en revanche ~400 Mo le temps de la sonde, d'où le cache
 * et le fait que les deux informations soient lues d'un coup.
 */

const CACHE_TTL_MS = 60 * 60 * 1000

interface Listing {
  models: ModelInfo[]
  account: AccountInfo | null
}

export class ClaudeModelCatalog {
  private readonly cached = new CachedProbe(CACHE_TTL_MS, () => this.probe())

  /**
   * Le binaire est résolu à chaque sonde, jamais retenu à la construction : c'est ce qui
   * fait honorer le préfixe des CLI que Sillage installe lui-même, et le réglage
   * `agents.claude.binary`, y compris pour un CLI installé pendant que le daemon tourne.
   */
  constructor(private readonly executable: () => Promise<string>) {}

  list(): Promise<Listing & { fetchedAt: number }> {
    return this.cached.read()
  }

  private probe(): Promise<Listing> {
    return withControlSession(
      { executable: this.executable, cwd: homedir(), tag: 'catalog' },
      async (session) => {
        const models = await session.supportedModels()
        // Le compte est secondaire : son absence ne doit pas priver l'UI des modèles.
        const account = await session.accountInfo().catch(() => null)
        return { models, account }
      },
    )
  }
}
