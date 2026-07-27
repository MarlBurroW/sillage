import { homedir } from 'node:os'
import {
  query,
  type AccountInfo,
  type ModelInfo,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from '../async-queue.js'

/**
 * Catalogue Claude : modèles et compte, lus depuis le CLI installé plutôt que codés
 * en dur.
 *
 * `supportedModels()` et `accountInfo()` sont des requêtes de contrôle : elles
 * exigent un process CLI vivant, mais aucun message n'est envoyé, donc elles ne
 * consomment ni tokens ni quota. Le process coûte en revanche ~400 Mo le temps de la
 * sonde, d'où le cache et le fait que les deux informations soient lues d'un coup.
 */

const CACHE_TTL_MS = 60 * 60 * 1000
const PROBE_TIMEOUT_MS = 20_000

interface Probe {
  models: ModelInfo[]
  account: AccountInfo | null
  fetchedAt: number
}

export class ClaudeModelCatalog {
  private cache: Probe | null = null
  /** Une sonde à la fois : dix requêtes simultanées ne doivent pas lancer dix CLI. */
  private inflight: Promise<Omit<Probe, 'fetchedAt'>> | null = null

  async list(): Promise<Probe> {
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) return this.cache

    this.inflight ??= this.probe().finally(() => {
      this.inflight = null
    })

    this.cache = { ...(await this.inflight), fetchedAt: Date.now() }
    return this.cache
  }

  private async probe(): Promise<Omit<Probe, 'fetchedAt'>> {
    // La file reste vide : le CLI démarre, répond aux requêtes de contrôle, et
    // s'arrête sans qu'aucun tour de conversation n'ait lieu.
    const input = new AsyncQueue<SDKUserMessage>()
    const abort = new AbortController()

    const session = query({
      prompt: input,
      options: { cwd: homedir(), abortController: abort, stderr: () => {} },
    })

    const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS)
    try {
      const models = await session.supportedModels()
      // Le compte est secondaire : son absence ne doit pas priver l'UI des modèles.
      const account = await session.accountInfo().catch(() => null)
      return { models, account }
    } finally {
      clearTimeout(timer)
      input.close()
      abort.abort()
    }
  }
}
