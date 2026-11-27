import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { AgentUsage, UsageResetCredits, UsageResetOutcome, UsageWindow } from '@sillage/protocol'
import type {
  ConsumeAccountRateLimitResetCreditResponse,
  GetAccountRateLimitsResponse,
  RateLimitResetCredit,
  RateLimitResetCreditsSummary,
  RateLimitSnapshot,
} from '@sillage/codex-bindings/v2'
import { CachedProbe, CachedProbeMap } from '../cached-probe.js'
import { USAGE_CACHE_TTL_MS } from '../usage-cache.js'
import { CodexAppServerClient } from './app-server-client.js'
import { CLIENT_INFO } from './client-info.js'
import { agentProcessEnv } from '../process-env.js'
import { describeWindow } from './quota.js'

/**
 * Codex account usage through account/rateLimits/read. App-server is much lighter than Claude
 * sessions but still starts a process, so cache readings.
 */

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
    // The protocol uses seconds; the rest of Sillage uses milliseconds.
    resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000,
  }
}

function toCredits(snapshot: RateLimitSnapshot): AgentUsage['credits'] {
  const credits = snapshot.credits
  if (!credits) return null

  return {
    label: 'Crédits',
    // App-server reports balances rather than rates: invented percentages would require
    // a ceiling the protocol never supplies.
    utilization: null,
    detail: credits.unlimited ? 'illimités' : `solde ${credits.balance}`,
    enabled: credits.hasCredits,
  }
}

/** Available credits, soonest expiry first: the one worth spending before it is lost. */
function availableCredits(summary: RateLimitResetCreditsSummary | null): RateLimitResetCredit[] {
  return (summary?.credits ?? [])
    .filter((credit) => credit.status === 'available')
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))
}

/**
 * Probed on codex-cli 0.172.0: `availableCount` is a JSON number despite the generated `bigint`.
 * Null without a credit, so the panel offers nothing to spend.
 */
export function toResetCredits(summary: RateLimitResetCreditsSummary | null): UsageResetCredits | null {
  const available = Number(summary?.availableCount ?? 0)
  if (!summary || available <= 0) return null
  const next = availableCredits(summary)[0]
  return {
    available,
    nextExpiresAt: next?.expiresAt ? next.expiresAt * 1000 : null,
    title: next?.title ?? null,
    description: next?.description ?? null,
  }
}

function normalize(response: GetAccountRateLimitsResponse): Omit<AgentUsage, 'fetchedAt'> {
  const buckets = response.rateLimitsByLimitId ?? { [response.rateLimits.limitId ?? '']: response.rateLimits }
  const entries = Object.entries(buckets).filter(
    (entry): entry is [string, RateLimitSnapshot] => entry[1] !== undefined,
  )

  const windows: UsageWindow[] = []
  for (const [limitId, snapshot] of entries) {
    // Prefixes distinguish multiple counters; with one they would
    // only add another word to read.
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
    resetCredits: toResetCredits(response.rateLimitResetCredits ?? null),
  }
}

export class CodexUsageReader {
  private readonly cached = new CachedProbe(USAGE_CACHE_TTL_MS, () => this.probe())
  /** One probe per additional account within its home. */
  private readonly byAccount = new CachedProbeMap<Omit<AgentUsage, 'fetchedAt'>>(
    USAGE_CACHE_TTL_MS,
    (accountId) => {
      const home = this.homes.get(accountId)
      if (!home) throw new Error('Home du compte Codex introuvable.')
      return this.probe(home)
    },
  )
  private readonly homes = new Map<string, string>()

  constructor(private readonly executable: () => Promise<string>) {}

  read(force = false): Promise<AgentUsage> {
    return this.cached.read(force)
  }

  /**
   * Spends one free reset of the account (the CLI's own login without `home`). Irreversible: the
   * route asks for it only after an explicit confirmation, and nothing calls it on its own. Picks
   * the credit that expires first rather than letting the backend choose. The idempotency key is
   * fresh per attempt, as the protocol asks; readings are dropped so the panel shows the reset.
   */
  async consumeReset(home?: string): Promise<UsageResetOutcome> {
    const outcome = await this.withClient(home, async (client) => {
      const usage = await client.call<GetAccountRateLimitsResponse, 'account/rateLimits/read'>('account/rateLimits/read', undefined)
      const credit = availableCredits(usage.rateLimitResetCredits ?? null)[0]
      const response = await client.call<ConsumeAccountRateLimitResetCreditResponse, 'account/rateLimitResetCredit/consume'>(
        'account/rateLimitResetCredit/consume',
        { idempotencyKey: randomUUID(), creditId: credit?.id ?? null },
      )
      return response.outcome satisfies UsageResetOutcome
    })
    this.cached.invalidate()
    this.byAccount.invalidate()
    return outcome
  }

  /** Usage for the account identified by the supplied CODEX_HOME. */
  async readForAccount(accountId: string, home: string, force = false): Promise<AgentUsage> {
    this.homes.set(accountId, home)
    try {
      return await this.byAccount.read(accountId, force)
    } finally {
      this.homes.delete(accountId)
    }
  }

  private probe(home?: string): Promise<Omit<AgentUsage, 'fetchedAt'>> {
    return this.withClient(home, async (client) => normalize(
      await client.call<GetAccountRateLimitsResponse, 'account/rateLimits/read'>('account/rateLimits/read', undefined),
    ))
  }

  private async withClient<T>(home: string | undefined, run: (client: CodexAppServerClient) => Promise<T>): Promise<T> {
    const client = new CodexAppServerClient({
      binary: await this.executable(),
      cwd: home ?? homedir(),
      ...(home ? { env: agentProcessEnv({ CODEX_HOME: home }) } : {}),
      onNotification: () => {},
      onServerRequest: () =>
        Promise.reject(new Error('Aucune requête serveur attendue pendant la lecture du quota.')),
    })

    try {
      await client.initialize(CLIENT_INFO)
      return await run(client)
    } finally {
      client.close()
    }
  }
}
