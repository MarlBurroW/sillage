import { homedir } from 'node:os'
import type { AgentUsage, UsageWindow } from '@sillage/protocol'
import { CachedProbe, CachedProbeMap } from '../cached-probe.js'
import { USAGE_CACHE_TTL_MS } from '../usage-cache.js'
import { withControlSession } from './control-session.js'

/** Claude account usage from the control request feeding `/usage`. SDK `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` explicitly permits shape changes without notice. Parse defensively, ignore unknown fields and tolerate omissions. Probe failures must affect usage display only. */

const PROBE_TIMEOUT_MS = 25_000

/** SDK-documented usage window labels. Unknown windows retain original keys rather than disappear, allowing server-added windows without code changes. */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5 heures',
  seven_day: '7 jours',
  seven_day_opus: '7 jours · Opus',
  seven_day_sonnet: '7 jours · Sonnet',
  seven_day_oauth_apps: '7 jours · applications',
}

/** Usable windows contain utilization and reset dates. */
function toWindow(id: string, label: string, value: unknown): UsageWindow | null {
  if (typeof value !== 'object' || value === null) return null
  const fields = value as { utilization?: unknown; resets_at?: unknown }

  const hasUtilization = typeof fields.utilization === 'number'
  const hasReset = typeof fields.resets_at === 'string'
  // Payloads also contain booleans, arrays and monetary blocks:
  // their shapes distinguish them from windows.
  if (!hasUtilization && !hasReset) return null

  const resetsAt = hasReset ? Date.parse(fields.resets_at as string) : Number.NaN

  return {
    id,
    label,
    // CLI uses percentages; Sillage uses ratios.
    utilization: hasUtilization ? (fields.utilization as number) / 100 : null,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
  }
}

/** Amounts in CLI-supplied minor units. */
function formatAmount(minor: unknown, places: unknown, currency: unknown): string | null {
  if (typeof minor !== 'number') return null
  // `decimal_places` accompanies amounts despite missing SDK declarations.
  // Without scales, showing 4250 instead of €42.50 is worse
  // than displaying nothing.
  if (typeof places !== 'number') return null

  return new Intl.NumberFormat('fr-FR', {
    style: typeof currency === 'string' ? 'currency' : 'decimal',
    currency: typeof currency === 'string' ? currency : undefined,
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  }).format(minor / 10 ** places)
}

function toCredits(extra: unknown): AgentUsage['credits'] {
  if (typeof extra !== 'object' || extra === null) return null
  const fields = extra as Record<string, unknown>

  const used = formatAmount(fields.used_credits, fields.decimal_places, fields.currency)
  const limit = formatAmount(fields.monthly_limit, fields.decimal_places, fields.currency)

  return {
    label: "Crédits d'usage",
    utilization: typeof fields.utilization === 'number' ? fields.utilization / 100 : null,
    detail: used && limit ? `${used} sur ${limit}` : null,
    enabled: fields.is_enabled === true,
  }
}

function normalize(payload: unknown): Omit<AgentUsage, 'fetchedAt'> {
  const usage = payload as {
    subscription_type?: unknown
    rate_limits_available?: unknown
    rate_limits?: Record<string, unknown> | null
  }

  const limits = usage.rate_limits ?? {}
  const windows: UsageWindow[] = []

  for (const [key, value] of Object.entries(limits)) {
    if (key === 'model_scoped' || key === 'extra_usage') continue
    const window = toWindow(key, WINDOW_LABELS[key] ?? key.replaceAll('_', ' '), value)
    if (window) windows.push(window)
  }

  // Server-provided per-model windows allow new models such as Fable
  // to receive dedicated gauges with supplied labels.
  const scoped = limits.model_scoped
  if (Array.isArray(scoped)) {
    for (const entry of scoped) {
      const label = (entry as { display_name?: unknown }).display_name
      if (typeof label !== 'string') continue
      const window = toWindow(`model:${label}`, label, entry)
      if (window) windows.push(window)
    }
  }

  return {
    agent: 'claude',
    plan: typeof usage.subscription_type === 'string' ? usage.subscription_type : null,
    limitsAvailable: usage.rate_limits_available === true,
    windows,
    credits: toCredits(limits.extra_usage),
  }
}

export class ClaudeUsageReader {
  private readonly cached = new CachedProbe(USAGE_CACHE_TTL_MS, () => this.probe())
  /** Resolved on every probe like catalogs; see `ClaudeModelCatalog`. */
  constructor(private readonly executable: () => Promise<string>) {}

  read(force = false): Promise<AgentUsage> {
    return this.cached.read(force)
  }

  /** Additional-subscription usage using gauge logins (`ClaudeAccountGauges`). Probe per account separately from default CLI login; provide directories on every read rather than retain them. */
  async readForConfigDir(accountId: string, configDir: string, force = false): Promise<AgentUsage> {
    this.dirs.set(accountId, configDir)
    try {
      return await this.byAccount.read(accountId, force)
    } finally {
      this.dirs.delete(accountId)
    }
  }

  private readonly dirs = new Map<string, string>()
  private readonly byAccount = new CachedProbeMap<Omit<AgentUsage, 'fetchedAt'>>(USAGE_CACHE_TTL_MS, (accountId) => {
    const configDir = this.dirs.get(accountId)
    if (!configDir) throw new Error('Dossier de jauge introuvable.')
    return this.probe(configDir)
  })

  private probe(configDir?: string): Promise<Omit<AgentUsage, 'fetchedAt'>> {
    // Control-only requests consume neither tokens nor quota.
    return withControlSession(
      {
        executable: this.executable,
        cwd: homedir(),
        tag: 'usage',
        timeoutMs: PROBE_TIMEOUT_MS,
        // Gauge directories without variables prioritizing another
        // login over its own.
        ...(configDir ? { options: { env: withoutAuthOverrides({ ...process.env, CLAUDE_CONFIG_DIR: configDir }) } } : {}),
      },
      async (session) =>
        normalize(await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()),
    )
  }
}

/** Authentication overriding configuration-directory login (see documented precedence). */
function withoutAuthOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE', 'NODE_ENV']) {
    delete next[name]
  }
  return next
}

/** Known usage state for additional accounts without gauges, without probing. API keys have no subscription. setup-token subscriptions carry only `user:inference` (authorization URL, 2.1.296), lacking `user:profile`, so CLIs do not request inapplicable limits. Spawning 400 MB processes to learn this wastes resources; screens explain missing gauges from account kinds. */
export function claudeAccountUsage(): AgentUsage {
  return { agent: 'claude', plan: null, limitsAvailable: false, windows: [], credits: null, fetchedAt: Date.now() }
}
