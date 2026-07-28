import type { CollaborationModeMask, Model, ModelListResponse } from '@sillage/protocol/codex/v2'
import { CodexAppServerClient } from './app-server-client.js'
import { CLIENT_INFO } from './client-info.js'

/**
 * Catalogue des modèles et des modes de collaboration Codex, lus sur l'app-server.
 *
 * Même contrat que côté Claude : rien n'est codé en dur, et le résultat est mis en
 * cache parce que la sonde démarre un process CLI. Les deux listes sont lues dans la
 * même sonde, pour ne pas payer un second démarrage.
 */

interface Listing {
  models: Model[]
  modes: CollaborationModeMask[]
}

const CACHE_TTL_MS = 60 * 60 * 1000

export class CodexModelCatalog {
  private cache: (Listing & { fetchedAt: number }) | null = null
  private inflight: Promise<Listing> | null = null

  constructor(private readonly binary: string) {}

  async list(): Promise<Listing & { fetchedAt: number }> {
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) return this.cache

    this.inflight ??= this.probe().finally(() => {
      this.inflight = null
    })

    const listing = await this.inflight
    this.cache = { ...listing, fetchedAt: Date.now() }
    return this.cache
  }

  private async probe(): Promise<Listing> {
    const client = new CodexAppServerClient({ binary: this.binary })
    try {
      await client.initialize(CLIENT_INFO)

      // `model/list` est paginé : s'arrêter à la première page masquerait les modèles
      // suivants, exactement le genre de troncature silencieuse à éviter.
      const models: Model[] = []
      let cursor: string | null = null
      do {
        // Annotation explicite : `cursor` est alimenté par la réponse, donc son type
        // serait circulaire s'il était inféré depuis `page`.
        const page: ModelListResponse = await client.call<ModelListResponse, 'model/list'>('model/list', {
          includeHidden: false,
          cursor,
          limit: null,
        })
        models.push(...page.data)
        cursor = page.nextCursor
      } while (cursor)

      // Méthode expérimentale : une version de Codex qui ne la connaît pas ne doit pas
      // priver l'utilisateur du reste du catalogue, seulement du sélecteur de mode.
      const modes = await client
        .callExperimental<{ data: CollaborationModeMask[] }>('collaborationMode/list', {})
        .then((response) => response.data)
        .catch(() => [])

      return { models, modes }
    } finally {
      client.close()
    }
  }
}
