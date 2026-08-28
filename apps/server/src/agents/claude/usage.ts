import { homedir } from 'node:os'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentUsage, UsageWindow } from '@sillage/protocol'
import { AsyncQueue } from '../async-queue.js'
import { CachedProbe } from '../cached-probe.js'
import { USAGE_CACHE_TTL_MS } from '../usage-cache.js'

/**
 * Consommation du compte Claude, lue par la requête de contrôle qui alimente `/usage`.
 *
 * La méthode du SDK s'appelle `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`
 * et sa documentation prévient que la forme peut changer sans préavis. C'est pourquoi
 * la lecture ci-dessous ne présume rien : elle parcourt ce qui est là, ignore ce qu'elle
 * ne reconnaît pas, et n'échoue jamais sur un champ manquant. Une panne de cette sonde
 * ne doit priver l'UI que de la consommation, pas d'autre chose.
 */

const PROBE_TIMEOUT_MS = 25_000

/**
 * Libellés des fenêtres documentées par le SDK. Tout ce qui n'y figure pas est affiché
 * avec sa clé d'origine plutôt qu'ignoré : c'est ainsi qu'une fenêtre ajoutée côté
 * serveur apparaît sans qu'on ait à toucher au code.
 */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5 heures',
  seven_day: '7 jours',
  seven_day_opus: '7 jours · Opus',
  seven_day_sonnet: '7 jours · Sonnet',
  seven_day_oauth_apps: '7 jours · applications',
}

/** Une fenêtre exploitable porte un taux et une date de remise à zéro. */
function toWindow(id: string, label: string, value: unknown): UsageWindow | null {
  if (typeof value !== 'object' || value === null) return null
  const fields = value as { utilization?: unknown; resets_at?: unknown }

  const hasUtilization = typeof fields.utilization === 'number'
  const hasReset = typeof fields.resets_at === 'string'
  // Le payload contient aussi des booléens, des tableaux et des blocs monétaires :
  // rien de tout ça n'est une fenêtre, et la forme suffit à les écarter.
  if (!hasUtilization && !hasReset) return null

  const resetsAt = hasReset ? Date.parse(fields.resets_at as string) : Number.NaN

  return {
    id,
    label,
    // Le CLI compte en pourcentage, le reste de Sillage en ratio.
    utilization: hasUtilization ? (fields.utilization as number) / 100 : null,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
  }
}

/** Montant en unités mineures, tel que le CLI le transmet. */
function formatAmount(minor: unknown, places: unknown, currency: unknown): string | null {
  if (typeof minor !== 'number') return null
  // `decimal_places` n'est pas déclaré par le type du SDK mais accompagne les montants.
  // Sans lui on ne connaît pas l'échelle, et afficher 4250 pour 42,50 € serait pire
  // que de ne rien afficher.
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

  // Fenêtres par modèle, alimentées par le serveur : c'est par ce canal qu'une
  // nouveauté comme Fable obtient sa propre jauge, avec son libellé déjà rédigé.
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

  /** Résolu à chaque sonde, comme pour le catalogue : voir `ClaudeModelCatalog`. */
  constructor(private readonly executable: () => Promise<string>) {}

  read(force = false): Promise<AgentUsage> {
    return this.cached.read(force)
  }

  private async probe(): Promise<Omit<AgentUsage, 'fetchedAt'>> {
    // La file reste vide : le CLI démarre, répond à la requête de contrôle et s'arrête.
    // Aucun tour n'a lieu, donc la lecture ne consomme ni tokens ni quota.
    const input = new AsyncQueue<SDKUserMessage>()
    const abort = new AbortController()

    const session = query({
      prompt: input,
      options: {
        cwd: homedir(),
        abortController: abort,
        // Le SDK ne doit jamais chercher son propre binaire : la release ne transporte
        // plus le paquet plateforme. Voir `ClaudeModelCatalog`.
        pathToClaudeCodeExecutable: await this.executable(),
        stderr: (data) => process.stderr.write(`[claude usage] ${data}`),
      },
    })

    const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS)
    try {
      return normalize(await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET())
    } finally {
      clearTimeout(timer)
      input.close()
      abort.abort()
    }
  }
}
