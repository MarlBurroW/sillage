import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'
import {
  claudeEffortSchema,
  isPermissiveConfig,
  shortModelName,
  validComparisonDraft,
  variantEffort,
  type AgentConfig,
  type AgentKind,
  type AgentModelDto,
  type BenchmarkComparisonDraft,
  type BenchmarkDto,
  type BenchmarkPresetBody,
  type BenchmarkPresetDto,
  type ModelListPrice,
  type UpdateBenchmarkSettingsBody,
} from '@sillage/protocol'
import { agentModelsQuery, catalogModel, modelsAccount } from './agents'

/**
 * A benchmark lineup while it is edited: in the creation form, from a preset, or when an existing
 * benchmark is continued. Pure logic and catalog reads; the screens decide how rows look.
 */

/** One configuration of the lineup. */
export interface LineupRow {
  /** Stable React and drag key; never sent. */
  key: string
  /** CLI of the row, known even when a stored configuration no longer parses. */
  agent: AgentKind
  /** Null for a preset variant whose stored configuration no longer parses: it blocks launch until removed. */
  config: AgentConfig | null
  /** Name the user wrote; null shows the automatic one. */
  label: string | null
  /** Existing variant of a benchmark: its configuration is frozen, only its place and name change. */
  variantId?: string
  /**
   * What the benchmark this row was copied from knew about its model, for when the CLI's catalog
   * no longer lists it: the row keeps its public name and price instead of a bare id.
   */
  known?: { modelId: string | null; publicName: string | null; price: ModelListPrice | null }
}

let rowCounter = 0

/** Unique within the page. Not `crypto.randomUUID`: it only exists in secure contexts, and tailnet URLs are plain HTTP. */
export function newRowKey(): string {
  rowCounter += 1
  return `row-${rowCounter}-${Math.random().toString(36).slice(2, 8)}`
}

/** A comparison kept while editing, by row: positions shift as rows move. */
export interface LineupComparison {
  title: string | null
  keys: string[]
}

/** Positions for the create body or a preset; comparisons left with fewer than two contestants go. */
export function comparisonDrafts(comparisons: LineupComparison[], rows: LineupRow[]): BenchmarkComparisonDraft[] {
  const position = new Map(rows.map((row, index) => [row.key, index]))
  return comparisons
    .map((comparison) => ({ title: comparison.title, variants: comparison.keys.map((key) => position.get(key)).filter((index): index is number => index !== undefined) }))
    .filter((draft) => validComparisonDraft(draft, rows.length))
}

/** The reverse, when a preset or a benchmark fills the form. */
export function comparisonsFromDrafts(drafts: BenchmarkComparisonDraft[], rows: LineupRow[]): LineupComparison[] {
  return drafts
    .filter((draft) => validComparisonDraft(draft, rows.length))
    .map((draft) => ({ title: draft.title, keys: draft.variants.map((index) => rows[index]!.key) }))
}

/** Drops removed rows from comparisons, and comparisons left with fewer than two contestants. */
export function pruneComparisons(comparisons: LineupComparison[], rows: LineupRow[]): LineupComparison[] {
  const keys = new Set(rows.map((row) => row.key))
  return comparisons
    .map((comparison) => ({ ...comparison, keys: comparison.keys.filter((key) => keys.has(key)) }))
    .filter((comparison) => comparison.keys.length >= 2)
}

// --- Facts read from the catalogs ---------------------------------------------------

/** Effort levels from least to most thinking; unknown names follow, models without effort last. */
export const EFFORT_RANK: Record<string, number> = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 }

/** What a row will run, as far as the catalog of its CLI and account says before any run. */
export interface LineupFacts {
  /** Model the row runs, an alias resolved through the catalog when it can be; null for an unresolved CLI default. */
  modelId: string | null
  /** Public name of that model from the reference list, short form ("Opus 5.5", "GPT-6.2 Astra"). */
  publicName: string | null
  /** Name the CLI gives the entry, when the reference list does not know the model. */
  catalogName: string | null
  /** Public list rates per million tokens; null when not listed (new models often are not yet). */
  price: ModelListPrice | null
  /** Raw effort value, as benchmark names show it. */
  effort: string | null
  /** The catalog was read and no longer lists the configured model. */
  unlisted: boolean
  /** A permission mode that may stop and ask: an unattended run would wait for an answer. */
  mayAsk: boolean
}

export const catalogKey = (agent: AgentKind, account: string | null) => `${agent}:${account ?? ''}`

/**
 * CLIs whose server fills an effort left at the CLI default before the benchmark is written (the
 * `resolveDefaults` of the Codex and Grok adapters). The others store it empty, and the pages then
 * name the variant without one: a form reading the catalog's default for them would disagree.
 */
const EFFORT_RESOLVED_AT_LAUNCH: ReadonlySet<AgentKind> = new Set<AgentKind>(['codex', 'grok'])

export function rowFacts(config: AgentConfig, models: AgentModelDto[] | undefined, known?: LineupRow['known']): LineupFacts {
  // The CLI default sentinel names no model: the catalog says which one it would pick.
  const value = config.model || models?.find((model) => model.isDefault)?.value || ''
  const entry = value ? catalogModel(models, value) : undefined
  // The default entry of Claude is named "Default (recommended)": name the alias sharing its model instead.
  const sibling = entry?.isDefault && entry.hint ? models?.find((model) => !model.isDefault && model.hint === entry.hint) : undefined
  // The catalog speaks for what the CLI offers now; a copied benchmark only fills what it does not list.
  const fallback = entry ? undefined : known
  return {
    modelId: entry?.hint ?? entry?.value ?? fallback?.modelId ?? (config.model || null),
    publicName: entry?.publicName ? shortModelName(entry.publicName) : (fallback?.publicName ?? null),
    catalogName: (sibling ?? entry)?.displayName ?? null,
    price: entry?.listPrice ?? fallback?.price ?? null,
    // Where the server resolves a CLI default effort, it picks what the catalog says here: names
    // and the "efforts differ" rule must read the same value the server will store.
    effort: variantEffort(config) || (EFFORT_RESOLVED_AT_LAUNCH.has(config.agent) ? entry?.defaultEffort : null) || null,
    unlisted: models !== undefined && config.model !== '' && entry === undefined,
    mayAsk: !isPermissiveConfig(config),
  }
}

/**
 * Automatic name of a row, as the benchmark will show it once launched: the public name of the
 * model, with the effort only when the lineup mixes efforts. The written label wins. `fallback`
 * names a CLI default nobody resolved yet, in the reader's language.
 */
export function rowTitle(row: LineupRow, facts: LineupFacts | undefined, effortsDiffer: boolean, fallback: string): string {
  if (row.label) return row.label
  const name = facts?.publicName ?? facts?.catalogName ?? facts?.modelId ?? (row.config?.model || fallback)
  const effort = facts?.effort ?? (row.config ? variantEffort(row.config) : null)
  return effortsDiffer && effort ? `${name} · ${effort}` : name
}

/** Whether names must carry efforts, read from the efforts the rows will actually run with. */
export function rowsEffortsDiffer(rows: LineupRow[], facts: Map<string, LineupFacts>): boolean {
  const efforts = rows.flatMap((row) => (row.config ? [facts.get(row.key)?.effort ?? variantEffort(row.config) ?? ''] : []))
  return new Set(efforts).size > 1
}

/**
 * Catalogs of every CLI and account a lineup uses, read once each through the composer's cache.
 * CLIs that are not installed are not probed: the probe would only answer that they are missing.
 */
export function useLineupCatalogs(rows: LineupRow[], installed: (agent: AgentKind) => boolean): Map<string, AgentModelDto[] | undefined> {
  const pairs = useMemo(() => {
    const seen = new Map<string, { agent: AgentKind; account: string | null }>()
    for (const row of rows) {
      if (!row.config) continue
      const account = modelsAccount(row.config)
      seen.set(catalogKey(row.agent, account), { agent: row.agent, account })
    }
    return [...seen.entries()]
  }, [rows])
  const results = useQueries({ queries: pairs.map(([, pair]) => agentModelsQuery(pair.agent, installed(pair.agent), pair.account)) })
  return useMemo(() => new Map(pairs.map(([key], index) => [key, results[index]?.data?.models])), [pairs, results])
}

export function useLineupFacts(rows: LineupRow[], installed: (agent: AgentKind) => boolean): Map<string, LineupFacts> {
  const catalogs = useLineupCatalogs(rows, installed)
  return useMemo(() => {
    const facts = new Map<string, LineupFacts>()
    for (const row of rows) {
      if (!row.config) continue
      facts.set(row.key, rowFacts(row.config, catalogs.get(catalogKey(row.agent, modelsAccount(row.config))), row.known))
    }
    return facts
  }, [rows, catalogs])
}

// --- Arranging --------------------------------------------------------------------------

export type ArrangeKey = 'priceAsc' | 'priceDesc' | 'effortAsc' | 'cli' | 'name' | 'reverse' | 'durationAsc' | 'costAsc' | 'ratingAsc'

/** Measured medians per row, for arranging an existing benchmark by its results. */
export type MeasuredRows = Map<string, { durationMs: number | null; costUsd: number | null; rating: number | null }>

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

const AGENT_ORDER: AgentKind[] = ['claude', 'codex', 'opencode', 'grok', 'antigravity', 'copilot']

function effortRank(effort: string | null): number {
  if (effort === null || effort === '') return Number.POSITIVE_INFINITY
  return EFFORT_RANK[effort] ?? 100
}

/** Unknown values sink whatever the direction: they are not small, they are unknown. */
function byNullable(a: number | null, b: number | null, direction: 1 | -1): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return (a - b) * direction
}

function byPrice(a: LineupFacts | undefined, b: LineupFacts | undefined, direction: 1 | -1): number {
  return byNullable(a?.price?.output ?? null, b?.price?.output ?? null, direction)
    || byNullable(a?.price?.input ?? null, b?.price?.input ?? null, direction)
}

/**
 * The lineup sorted once: the order is what gets frozen, so a sort rewrites it and the user can
 * still drag afterwards. Every sort is stable, the last tie-break being the current position.
 * Price uses the output rate, then the input rate, then the effort: the same model at a lower
 * effort costs less. That orders a mixed lineup by range (Haiku and Luna, then Terra, Sonnet and
 * Sol, Opus, Fable and Astra), the "worst first" order a video builds suspense on.
 */
export function arrangeRows(
  rows: LineupRow[],
  facts: Map<string, LineupFacts>,
  key: ArrangeKey,
  titles: Map<string, string>,
  measured?: MeasuredRows,
): LineupRow[] {
  if (key === 'reverse') return [...rows].reverse()
  const position = new Map(rows.map((row, index) => [row.key, index]))
  const effortOf = (row: LineupRow) => effortRank(facts.get(row.key)?.effort ?? (row.config ? variantEffort(row.config) : null))
  const compare = (a: LineupRow, b: LineupRow): number => {
    const fa = facts.get(a.key)
    const fb = facts.get(b.key)
    switch (key) {
      case 'priceAsc':
        return byPrice(fa, fb, 1) || effortOf(a) - effortOf(b)
      case 'priceDesc':
        return byPrice(fa, fb, -1) || effortOf(b) - effortOf(a)
      case 'effortAsc':
        return (effortOf(a) - effortOf(b) || 0) || byPrice(fa, fb, 1)
      case 'cli':
        return AGENT_ORDER.indexOf(a.agent) - AGENT_ORDER.indexOf(b.agent) || byPrice(fa, fb, 1) || effortOf(a) - effortOf(b)
      case 'name':
        return collator.compare(titles.get(a.key) ?? '', titles.get(b.key) ?? '')
      case 'durationAsc':
        return byNullable(measured?.get(a.key)?.durationMs ?? null, measured?.get(b.key)?.durationMs ?? null, 1)
      case 'costAsc':
        return byNullable(measured?.get(a.key)?.costUsd ?? null, measured?.get(b.key)?.costUsd ?? null, 1)
      case 'ratingAsc':
        // Worst rated first, the best one closing the lineup.
        return byNullable(measured?.get(a.key)?.rating ?? null, measured?.get(b.key)?.rating ?? null, 1)
    }
  }
  return [...rows].sort((a, b) => {
    const result = compare(a, b)
    // Infinity minus Infinity is NaN for rows without effort on both sides.
    return (Number.isNaN(result) ? 0 : result) || position.get(a.key)! - position.get(b.key)!
  })
}

/** Whether any row has a public price, which is what price sorts need to mean anything. */
export function anyPriced(rows: LineupRow[], facts: Map<string, LineupFacts>): boolean {
  return rows.some((row) => facts.get(row.key)?.price)
}

// --- Names --------------------------------------------------------------------------------

/**
 * Name of a copy: " (2)" is added, and a copy of a copy counts up ("… (3)"), so it reads apart
 * from the original in the list. Only that suffix is the app's to change. Any number the user
 * typed may be a model version ("Opus 5", "Grok Code Fast 1"), and "Opus 5" turned into "Opus 6"
 * would name another model: "Transformer Benchmark 3" becomes "Transformer Benchmark 3 (2)",
 * which the user renames if they meant 4.
 */
export function nextBenchmarkName(name: string, max: number): string {
  const trimmed = name.trim()
  const match = / \((\d+)\)$/.exec(trimmed)
  const base = match ? trimmed.slice(0, match.index) : trimmed
  const suffix = ` (${match ? Number(match[1]) + 1 : 2})`
  // A name already at the limit gives up its end, never the suffix that tells the copy apart.
  return `${base.slice(0, Math.max(0, max - suffix.length)).trimEnd()}${suffix}`
}

/**
 * Formats a list price as "$2.5 / $10", the rates per million input and output tokens. Cents
 * stay: rounding $1.25 to $1 would tie models that a price sort puts apart.
 */
export function formatListPrice(price: ModelListPrice, locale: string): string {
  // The narrow symbol: "4 $US / 20 $US" reads as noise next to a model name.
  const format = (value: number) => value.toLocaleString(locale, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 2, minimumFractionDigits: 0 })
  return `${format(price.input)} / ${format(price.output)}`
}

// --- Presets and copies -------------------------------------------------------------------

/** Rows of a stored preset; a variant that no longer parses keeps its place, flagged. */
export function rowsFromPreset(preset: BenchmarkPresetDto): LineupRow[] {
  return preset.variants.map((variant) => ({
    key: newRowKey(),
    agent: variant.config?.agent ?? variant.agent ?? 'claude',
    config: variant.config,
    label: variant.label,
    // The reference lists' word on the model, for a CLI whose catalog does not list it (yet).
    ...(variant.model ? { known: { modelId: variant.model, publicName: variant.publicName ?? null, price: variant.listPrice ?? null } } : {}),
  }))
}

/**
 * Rows of an existing benchmark, as a new lineup: frozen configurations copied, and only the
 * names the user wrote (an automatic name follows whatever model the copy runs).
 */
export function rowsFromBenchmark(benchmark: BenchmarkDto): LineupRow[] {
  return benchmark.variants.map((variant) => ({
    key: newRowKey(),
    agent: variant.config.agent,
    config: variant.config,
    label: variant.labelIsCustom ? variant.label : null,
    known: { modelId: variant.model, publicName: variant.publicName ?? null, price: variant.listPrice },
  }))
}

/** A benchmark's saved comparisons over rows built from it in the same order. */
export function comparisonsFromBenchmark(benchmark: BenchmarkDto, rows: LineupRow[]): LineupComparison[] {
  const keyOf = new Map(benchmark.variants.map((variant, index) => [variant.id, rows[index]?.key]))
  return benchmark.comparisons
    .map((comparison) => ({ title: comparison.title, keys: comparison.variantIds.map((id) => keyOf.get(id)).filter((key): key is string => key !== undefined) }))
    .filter((comparison) => comparison.keys.length >= 2)
}

/** What a preset stores, from rows that all parse. The prompt and script go in only when asked. */
export function presetBody(input: {
  name: string
  rows: LineupRow[]
  settings: UpdateBenchmarkSettingsBody
  comparisons: LineupComparison[]
  prompt: string | null
  checkScript: string | null
  checkTimeoutSeconds: number
}): BenchmarkPresetBody {
  const rows = input.rows.filter((row) => row.config)
  return {
    name: input.name.trim(),
    variants: rows.map((row) => ({ config: row.config!, ...(row.label?.trim() ? { label: row.label.trim() } : {}) })),
    repetitions: input.settings.repetitions,
    concurrency: input.settings.concurrency,
    maxDurationMinutes: input.settings.maxDurationMinutes,
    comparisons: comparisonDrafts(input.comparisons, rows),
    prompt: input.prompt?.trim() ? input.prompt.trim() : null,
    checkScript: input.checkScript?.trim() ? input.checkScript : null,
    checkTimeoutSeconds: input.checkTimeoutSeconds,
  }
}

/** Whether a name is taken among the account's presets, ignoring case as the server does. */
export function presetNamed(presets: BenchmarkPresetDto[] | undefined, name: string): BenchmarkPresetDto | undefined {
  const key = name.trim().toLowerCase()
  return key ? presets?.find((preset) => preset.name.trim().toLowerCase() === key) : undefined
}

/**
 * A configuration switched to another catalog model, the rest kept: the effort stays when the
 * model offers it, otherwise the model's default effort applies. Fast mode and Ultracode only
 * survive on the model they were chosen for, since an unsupported model would silently fall back
 * on another.
 */
export function withCatalogModel(config: AgentConfig, entry: AgentModelDto): AgentConfig {
  const current = variantEffort(config)
  const offered = entry.efforts.map((effort) => effort.value)
  const effort = current && (offered.length === 0 || offered.includes(current)) ? current : (entry.defaultEffort ?? current ?? '')
  switch (config.agent) {
    case 'claude': {
      const parsed = claudeEffortSchema.safeParse(effort)
      return {
        ...config,
        model: entry.value,
        effort: parsed.success ? parsed.data : config.effort,
        fastMode: config.fastMode && entry.supportsFastMode,
        ultracode: config.ultracode && entry.value === config.model,
      }
    }
    case 'opencode':
      return { ...config, model: entry.value, variant: effort }
    default:
      return { ...config, model: entry.value, reasoningEffort: effort }
  }
}
