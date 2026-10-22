import type { CollaborationModeMask, Model, ModelListResponse } from '@sillage/codex-bindings/v2'
import { CachedProbe } from '../cached-probe.js'
import { CodexAppServerClient } from './app-server-client.js'
import { CLIENT_INFO } from './client-info.js'

/**
 * Codex models and collaboration modes queried through app-server. Like Claude, nothing is
 * hardcoded and cache results because probing starts a CLI. Read both lists in one probe to avoid
 * extra startup. Resolve binaries on each probe rather than construction to honor Sillage
 * managed-install prefixes and newly installed CLI versions without daemon restart.
 */

interface Listing {
  models: Model[]
  modes: CollaborationModeMask[]
}

const CACHE_TTL_MS = 60 * 60 * 1000

export class CodexModelCatalog {
  private readonly cached = new CachedProbe(CACHE_TTL_MS, () => this.probe())

  constructor(private readonly executable: () => Promise<string>) {}

  list(): Promise<Listing & { fetchedAt: number }> {
    return this.cached.read()
  }

  private async probe(): Promise<Listing> {
    const client = new CodexAppServerClient({ binary: await this.executable() })
    try {
      await client.initialize(CLIENT_INFO)

      // model/list is paginated: stopping after page one would silently hide
      // later models, exactly the truncation to avoid.
      const models: Model[] = []
      let cursor: string | null = null
      do {
        // Explicit annotation avoids circular inference because response page
        // feeds cursor values.
        const page: ModelListResponse = await client.call<ModelListResponse, 'model/list'>('model/list', {
          includeHidden: false,
          cursor,
          limit: null,
        })
        models.push(...page.data)
        cursor = page.nextCursor
      } while (cursor)

      // Unknown experimental methods must remove only mode selection,
      // not the rest of the model catalog.
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
