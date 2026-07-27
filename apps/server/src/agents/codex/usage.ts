import { homedir } from 'node:os'
import type { AgentUsage, UsageWindow } from '@sillage/protocol'
import type { GetAccountRateLimitsResponse, RateLimitSnapshot } from '@sillage/protocol/codex/v2'
import { CodexAppServerClient } from './app-server-client.js'

/**
 * Consommation du compte Codex, lue par `account/rateLimits/read`.
 *
 * L'app-server est nettement plus léger qu'une session Claude, mais la lecture reste
 * mise en cache : elle démarre quand même un process.
 */

const CACHE_TTL_MS = 60_000
const CLIENT_INFO = { name: 'sillage', title: 'Sillage', version: '0.1.0' } as const

/** Libellé d'une fenêtre, à partir de ce que le CLI annonce. */
function describeWindow(limitName: string | null, durationMins: number | null): string {
  if (limitName) return limitName
  if (durationMins === null) return 'quota'
  if (durationMins < 60) return `${durationMins} min`
  const hours = durationMins / 60
  // 168 h se lit mal : au-delà d'une journée, on exprime en jours.
  return hours >= 24 && hours % 24 === 0 ? `${hours / 24} jours` : `${Math.round(hours)} heures`
}

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
  private cache: AgentUsage | null = null
  private inflight: Promise<Omit<AgentUsage, 'fetchedAt'>> | null = null

  constructor(private readonly binary: string) {}

  async read(force = false): Promise<AgentUsage> {
    if (!force && this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache
    }

    this.inflight ??= this.probe().finally(() => {
      this.inflight = null
    })

    this.cache = { ...(await this.inflight), fetchedAt: Date.now() }
    return this.cache
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
