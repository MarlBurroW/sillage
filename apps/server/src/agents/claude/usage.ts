import { homedir } from 'node:os'
import type { SDKRateLimitInfo, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentUsage, UsageWindow } from '@sillage/protocol'
import { CachedProbe, CachedProbeMap } from '../cached-probe.js'
import { USAGE_CACHE_TTL_MS } from '../usage-cache.js'
import { withControlSession } from './control-session.js'

/** Claude account usage from the control request feeding `/usage`. SDK `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` explicitly permits shape changes without notice. Parse defensively, ignore unknown fields and tolerate omissions. Probe failures must affect usage display only. */

const PROBE_TIMEOUT_MS = 25_000
/** Token probes run a real turn: CLI start plus one Haiku answer. */
const TOKEN_PROBE_TIMEOUT_MS = 45_000

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

  /** Additional-subscription usage read with the account's own `setup-token` token; see `probeToken`. Tokens are provided on every read rather than retained. */
  async readForToken(accountId: string, token: string, force = false): Promise<AgentUsage> {
    this.tokens.set(accountId, token)
    try {
      return await this.byAccount.read(accountId, force)
    } finally {
      this.tokens.delete(accountId)
    }
  }

  private readonly tokens = new Map<string, string>()
  private readonly byAccount = new CachedProbeMap<Omit<AgentUsage, 'fetchedAt'>>(USAGE_CACHE_TTL_MS, (accountId) => {
    const token = this.tokens.get(accountId)
    if (!token) throw new Error('Jeton du compte introuvable.')
    return this.probeToken(token)
  })

  /** setup-token tokens carry only `user:inference`: `/api/oauth/usage` answers 403 `oauth_scope_insufficient` and the usage control request reports nothing (probed 2.1.301). Every inference response, however, carries the unified limit headers, which the CLI forwards as `rate_limit_event` with `unifiedWindows` (5 h and 7 days, ratios and reset seconds). One Haiku "OK" turn costs about 2.5k cached input tokens; the cache TTL keeps that rare. No settings, tools, MCP servers or transcript: the probe must not run the user's hooks or appear in their history. */
  private probeToken(token: string): Promise<Omit<AgentUsage, 'fetchedAt'>> {
    return withControlSession(
      {
        executable: this.executable,
        cwd: homedir(),
        tag: 'usage',
        timeoutMs: TOKEN_PROBE_TIMEOUT_MS,
        options: {
          env: { ...withoutAuthOverrides(process.env), CLAUDE_CODE_OAUTH_TOKEN: token },
          model: 'haiku',
          maxTurns: 1,
          tools: [],
          settingSources: [],
          mcpServers: {},
          strictMcpConfig: true,
          persistSession: false,
        },
      },
      async (session, input) => {
        input.push({
          type: 'user',
          message: { role: 'user', content: 'Reply with OK.' },
          parent_tool_use_id: null,
          session_id: '',
        } as SDKUserMessage)
        const events: SDKRateLimitInfo[] = []
        for await (const message of session) {
          if (message.type === 'rate_limit_event') events.push(message.rate_limit_info)
          if (message.type === 'result') {
            if (message.is_error && events.length === 0) {
              throw new Error(`le compte n'a pas pu répondre (${'errors' in message ? message.errors.join(', ') : message.subtype})`)
            }
            break
          }
        }
        return usageFromRateLimits(events)
      },
    )
  }

  private probe(): Promise<Omit<AgentUsage, 'fetchedAt'>> {
    // Control-only requests consume neither tokens nor quota.
    return withControlSession(
      {
        executable: this.executable,
        cwd: homedir(),
        tag: 'usage',
        timeoutMs: PROBE_TIMEOUT_MS,
      },
      async (session) =>
        normalize(await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()),
    )
  }
}

/** Authentication that would take precedence over the token a probe sets (see documented precedence). */
function withoutAuthOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE', 'NODE_ENV']) {
    delete next[name]
  }
  return next
}

/** Usage from `rate_limit_event` payloads. `unifiedWindows` is absent from SDK types (0.3.301) but present on the wire: read it defensively and fall back to each event's own window, which names only the representative one. */
export function usageFromRateLimits(events: SDKRateLimitInfo[]): Omit<AgentUsage, 'fetchedAt'> {
  const byId = new Map<string, UsageWindow>()
  for (const info of events) {
    const unified = (info as { unifiedWindows?: unknown }).unifiedWindows
    if (typeof unified === 'object' && unified !== null) {
      for (const [id, value] of Object.entries(unified)) {
        const fields = value as { utilization?: unknown; resetsAt?: unknown }
        byId.set(id, {
          id,
          label: WINDOW_LABELS[id] ?? id.replaceAll('_', ' '),
          // Ratios already, unlike the percentages of `/api/oauth/usage`.
          utilization: typeof fields.utilization === 'number' ? fields.utilization : null,
          resetsAt: typeof fields.resetsAt === 'number' ? fields.resetsAt * 1000 : null,
        })
      }
    } else if (info.rateLimitType && info.rateLimitType !== 'overage' && !byId.has(info.rateLimitType)) {
      byId.set(info.rateLimitType, {
        id: info.rateLimitType,
        label: WINDOW_LABELS[info.rateLimitType] ?? info.rateLimitType.replaceAll('_', ' '),
        utilization: info.utilization ?? null,
        resetsAt: info.resetsAt === undefined ? null : info.resetsAt * 1000,
      })
    }
  }
  const windows = [...byId.values()]
  // Headers name neither the plan nor credits.
  return { agent: 'claude', plan: null, limitsAvailable: windows.length > 0, windows, credits: null }
}

/** API keys have no subscription, hence no limits to read: answer without probing. */
export function claudeAccountUsage(): AgentUsage {
  return { agent: 'claude', plan: null, limitsAvailable: false, windows: [], credits: null, fetchedAt: Date.now() }
}
