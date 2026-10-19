import { homedir } from 'node:os'
import type { AgentUsage, UsageWindow } from '@sillage/protocol'
import { AcpClient } from '../acp/client.js'
import { CachedProbe, CachedProbeMap } from '../cached-probe.js'
import { CLIENT_INFO } from '../codex/client-info.js'
import { agentProcessEnv } from '../process-env.js'
import { GROK_ISOLATION_ENV } from './launch.js'
import { fields } from './tools.js'

/**
 * Consommation d'un compte Grok, lue par l'extension `_x.ai/billing` d'un
 * `grok agent stdio` jetable (sondé sur 1.0.62 : `{config: {creditUsagePercent,
 * currentPeriod: {type, start, end}, onDemandCap, onDemandUsed, prepaidBalance…},
 * subscription_tier}`). Les montants sont en cents de dollar, sous `{val}`, et un
 * montant nul arrive comme `{}`.
 *
 * L'abonnement donne une enveloppe de crédits par période, hebdomadaire ou mensuelle :
 * c'est la seule fenêtre. Le dépassement payé à la demande et le solde prépayé passent
 * en crédits, comme chez les deux autres CLI.
 */

const PROBE_TIMEOUT_MS = 30_000

export type GrokUsage = Omit<AgentUsage, 'fetchedAt'>

function cents(value: unknown): number {
  const val = fields(value).val
  return typeof val === 'number' ? val : 0
}

function dollars(amount: number): string {
  return `${(amount / 100).toFixed(2)} $`
}

function periodLabel(type: unknown): string {
  if (type === 'USAGE_PERIOD_TYPE_WEEKLY') return '7 jours'
  if (type === 'USAGE_PERIOD_TYPE_MONTHLY') return '1 mois'
  return 'période en cours'
}

/** La réponse de `_x.ai/billing`, dans la forme commune. */
export function toGrokUsage(response: unknown): GrokUsage {
  const body = fields(response)
  const config = fields(body.config)
  const plan = typeof body.subscription_tier === 'string' ? body.subscription_tier : null

  const windows: UsageWindow[] = []
  if (typeof config.creditUsagePercent === 'number') {
    const period = fields(config.currentPeriod)
    const end = typeof period.end === 'string' ? period.end : config.billingPeriodEnd
    const resetsAt = typeof end === 'string' ? Date.parse(end) : NaN
    windows.push({
      id: 'credits',
      label: `Crédits · ${periodLabel(period.type)}`,
      utilization: Math.min(1, Math.max(0, config.creditUsagePercent / 100)),
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    })
  }

  const cap = cents(config.onDemandCap)
  const prepaid = cents(config.prepaidBalance)
  const credits: AgentUsage['credits'] = cap > 0
    ? {
        label: 'À la demande',
        utilization: Math.min(1, cents(config.onDemandUsed) / cap),
        detail: `${dollars(cents(config.onDemandUsed))} sur ${dollars(cap)}${prepaid > 0 ? ` · solde prépayé ${dollars(prepaid)}` : ''}`,
        enabled: body.on_demand_enabled !== false,
      }
    : prepaid > 0
      ? { label: 'Crédits prépayés', utilization: null, detail: `solde ${dollars(prepaid)}`, enabled: true }
      : null

  return { agent: 'grok', plan, limitsAvailable: windows.length > 0, windows, credits }
}

/**
 * Lit la consommation du compte connecté dans `home` (`GROK_HOME`), à défaut celle de la
 * connexion du CLI. Sans connexion, Grok refuse la requête : l'erreur remonte.
 */
export async function readGrokBilling(binary: string, home?: string): Promise<GrokUsage> {
  const client = new AcpClient({
    label: 'grok',
    binary,
    args: ['agent', '--no-leader', 'stdio'],
    cwd: home ?? homedir(),
    env: agentProcessEnv({ ...GROK_ISOLATION_ENV, ...(home ? { GROK_HOME: home } : {}) }),
  })
  const timeout = setTimeout(() => client.close(), PROBE_TIMEOUT_MS)
  try {
    await client.initialize(CLIENT_INFO)
    return toGrokUsage(await client.request('_x.ai/billing', {}))
  } finally {
    clearTimeout(timeout)
    client.close()
  }
}

/** La lecture démarre un process : elle est gardée une minute, comme celles de Codex. */
const USAGE_CACHE_TTL_MS = 60_000

/** Pas de connexion, ou une clé API sans abonnement : rien à montrer, et ce n'est pas une panne. */
const NO_LIMITS: GrokUsage = { agent: 'grok', plan: null, limitsAvailable: false, windows: [], credits: null }

export class GrokUsageReader {
  private readonly cached = new CachedProbe(USAGE_CACHE_TTL_MS, () => this.probe())
  /** Une lecture par compte supplémentaire, dans le home du compte. */
  private readonly byAccount = new CachedProbeMap<GrokUsage>(USAGE_CACHE_TTL_MS, (accountId) => {
    const home = this.homes.get(accountId)
    if (!home) throw new Error('Home du compte Grok introuvable.')
    return this.probe(home)
  })
  private readonly homes = new Map<string, string>()

  constructor(private readonly executable: () => Promise<string>) {}

  read(force = false): Promise<AgentUsage> {
    return this.cached.read(force)
  }

  async readForAccount(accountId: string, home: string, force = false): Promise<AgentUsage> {
    this.homes.set(accountId, home)
    try {
      return await this.byAccount.read(accountId, force)
    } finally {
      this.homes.delete(accountId)
    }
  }

  private async probe(home?: string): Promise<GrokUsage> {
    try {
      return await readGrokBilling(await this.executable(), home)
    } catch {
      return NO_LIMITS
    }
  }
}
