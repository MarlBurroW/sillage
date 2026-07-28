import { homedir } from 'node:os'
import type { AgentUsage, UsageWindow } from '@sillage/protocol'
import type { GetAccountRateLimitsResponse, RateLimitSnapshot } from '@sillage/codex-bindings/v2'
import { CachedProbe } from '../cached-probe.js'
import { CodexAppServerClient } from './app-server-client.js'
import { CLIENT_INFO } from './client-info.js'
import { describeWindow } from './quota.js'

/**
 * Consommation du compte Codex, lue par `account/rateLimits/read`.
 *
 * L'app-server est nettement plus léger qu'une session Claude, mais la lecture reste
 * mise en cache : elle démarre quand même un process.
 */

const CACHE_TTL_MS = 60_000

function toWindow(
  id: string,
  prefix: string,
  snapshot: RateLimitSnapshot,
  window: RateLimitSnapshot['primary'],
): UsageWindow | null {
  if (!window) return null

  const label = describeWindow(snapshot.limitName, window.windowDurationMins)
  return {
    id,
    label: prefix ? `${prefix} · ${label}` : label,
    utilization: window.usedPercent / 100,
    // Le protocole compte en secondes, tout le reste de Sillage en millisecondes.
    resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000,
  }
}

function toCredits(snapshot: RateLimitSnapshot): AgentUsage['credits'] {
  const credits = snapshot.credits
  if (!credits) return null

  return {
    label: 'Crédits',
    // L'app-server donne un solde, pas un taux : inventer un pourcentage supposerait
    // un plafond que le protocole ne transmet pas.
    utilization: null,
    detail: credits.unlimited ? 'illimités' : `solde ${credits.balance}`,
    enabled: credits.hasCredits,
  }
}

function normalize(response: GetAccountRateLimitsResponse): Omit<AgentUsage, 'fetchedAt'> {
  const buckets = response.rateLimitsByLimitId ?? { [response.rateLimits.limitId ?? '']: response.rateLimits }
  const entries = Object.entries(buckets).filter(
    (entry): entry is [string, RateLimitSnapshot] => entry[1] !== undefined,
  )

  const windows: UsageWindow[] = []
  for (const [limitId, snapshot] of entries) {
    // Le préfixe ne sert qu'à distinguer plusieurs compteurs : avec un seul, il
    // n'apporterait qu'un mot de plus à lire.
    const prefix = entries.length > 1 ? limitId : ''
    const primary = toWindow(`${limitId}:primary`, prefix, snapshot, snapshot.primary)
    const secondary = toWindow(`${limitId}:secondary`, prefix, snapshot, snapshot.secondary)
    if (primary) windows.push(primary)
    if (secondary) windows.push(secondary)
  }

  return {
    agent: 'codex',
    plan: response.rateLimits.planType,
    limitsAvailable: windows.length > 0,
    windows,
    credits: toCredits(response.rateLimits),
  }
}

export class CodexUsageReader {
  private readonly cached = new CachedProbe(CACHE_TTL_MS, () => this.probe())

  constructor(private readonly binary: string) {}

  read(force = false): Promise<AgentUsage> {
    return this.cached.read(force)
  }

  private async probe(): Promise<Omit<AgentUsage, 'fetchedAt'>> {
    const client = new CodexAppServerClient({
      binary: this.binary,
      cwd: homedir(),
      onNotification: () => {},
      onServerRequest: () =>
        Promise.reject(new Error('Aucune requête serveur attendue pendant la lecture du quota.')),
    })

    try {
      await client.initialize(CLIENT_INFO)
      return normalize(
        await client.call<GetAccountRateLimitsResponse, 'account/rateLimits/read'>(
          'account/rateLimits/read',
          undefined,
        ),
      )
    } finally {
      client.close()
    }
  }
}
