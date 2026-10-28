import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CollaborationModeMask, Model, ModelListResponse } from '@sillage/codex-bindings/v2'
import { CachedProbeMap } from '../cached-probe.js'
import { agentProcessEnv } from '../process-env.js'
import { CodexAppServerClient } from './app-server-client.js'
import { CLIENT_INFO } from './client-info.js'

/**
 * Codex models and collaboration modes queried through app-server. Like Claude, nothing is
 * hardcoded and cache results because probing starts a CLI. Read both lists in one probe to avoid
 * extra startup. Resolve binaries on each probe rather than construction to honor Sillage
 * managed-install prefixes and newly installed CLI versions without daemon restart.
 *
 * The list depends on the signed-in plan: app-server hides models the account cannot use, so
 * additional accounts (see CodexAccountHomes) probe with their own `CODEX_HOME`, one cache entry
 * per home. Keying on `auth.json` as well means a re-login in the same home is seen before the TTL.
 */

interface Listing {
  models: Model[]
  modes: CollaborationModeMask[]
}

const CACHE_TTL_MS = 60 * 60 * 1000

/** Empty when the CLI's own login is used: `CODEX_HOME` then stays whatever the daemon inherited. */
function authRevision(home: string | undefined): string {
  if (!home) return ''
  try {
    const file = statSync(join(home, 'auth.json'))
    return `${file.mtimeMs}:${file.size}`
  } catch {
    return 'none'
  }
}

export class CodexModelCatalog {
  private readonly cached = new CachedProbeMap<Listing>(CACHE_TTL_MS, (key) => {
    const { home } = JSON.parse(key) as { home?: string }
    return this.probe(home)
  })

  constructor(private readonly executable: () => Promise<string>) {}

  /** `home` is an account's `CODEX_HOME`; omitted for the CLI's own login. */
  invalidate(): void { this.cached.invalidate() }

  list(home?: string, force = false): Promise<Listing & { fetchedAt: number }> {
    return this.cached.read(JSON.stringify({ home, auth: authRevision(home) }), force)
  }

  private async probe(home?: string): Promise<Listing> {
    const client = new CodexAppServerClient({
      binary: await this.executable(),
      cwd: home ?? homedir(),
      ...(home ? { env: agentProcessEnv({ CODEX_HOME: home }) } : {}),
    })
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
