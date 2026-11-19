import { z } from 'zod'
import { agentConfigSchema, type AgentConfig } from './agent-config.js'
import { MAX_ATTACHMENTS_PER_MESSAGE, VIEWABLE_IMAGE_TYPES, VIEWABLE_MEDIA_TYPES, isAudioType } from './api.js'
import type { ModelListPrice } from './consumption.js'
import type { AgentKind } from './events.js'
import { MAX_CHECK_SCRIPT_CHARS, checkScriptSchema, checkTimeoutSchema, DEFAULT_CHECK_TIMEOUT_SECONDS } from './schedules.js'

/**
 * Model benchmarks: one prompt sent to several CLI configurations in fresh personal sessions, each
 * measured from its journal once it settles.
 *
 * Limits live here because the form displays them and the route rejects the same inputs.
 */

export const MAX_BENCHMARK_NAME_CHARS = 120
/** Same ceiling as scheduled prompts: beyond this, the prompt should reference a file. */
export const MAX_BENCHMARK_PROMPT_CHARS = 20000
export const MAX_BENCHMARK_VARIANT_LABEL_CHARS = 80
/**
 * Variants one launch may add, at creation or when continuing: enough to cross three CLIs with a
 * few efforts each; more at once would exhaust a subscription's window.
 */
export const MAX_BENCHMARK_VARIANTS = 12
/**
 * Variants a benchmark may reach by being continued as new models come out. Stays under 26 so
 * blind letters remain single characters.
 */
export const MAX_BENCHMARK_TOTAL_VARIANTS = 24
export const MAX_BENCHMARK_REPETITIONS = 5
export const MIN_BENCHMARK_DURATION_MINUTES = 1
export const MAX_BENCHMARK_DURATION_MINUTES = 4 * 60
/** A benchmark prompt is a bounded task: an agent still busy after this is wandering. */
export const DEFAULT_BENCHMARK_DURATION_MINUTES = 20
// A benchmark cannot contain more runs than this, so a higher limit has no effect.
export const MAX_BENCHMARK_CONCURRENCY = MAX_BENCHMARK_TOTAL_VARIANTS * MAX_BENCHMARK_REPETITIONS
export const benchmarkConcurrencySchema = z.number().int().min(1).max(MAX_BENCHMARK_CONCURRENCY)
export type BenchmarkConcurrency = z.infer<typeof benchmarkConcurrencySchema>

// Older clients used mode names. Preserve their meaning at the input boundary.
const benchmarkConcurrencyInputSchema = z.union([
  benchmarkConcurrencySchema,
  z.enum(['sequential', 'parallel']).transform((mode) => mode === 'parallel' ? 4 : 1),
])
export const benchmarkRepetitionsSchema = z.number().int().min(1).max(MAX_BENCHMARK_REPETITIONS)
export const benchmarkDurationSchema = z.number().int().min(MIN_BENCHMARK_DURATION_MINUTES).max(MAX_BENCHMARK_DURATION_MINUTES)
/** What stays adjustable once a benchmark exists: how much it runs, not what it measures. */
export const updateBenchmarkSettingsBodySchema = z.object({
  repetitions: benchmarkRepetitionsSchema,
  concurrency: benchmarkConcurrencySchema,
  maxDurationMinutes: benchmarkDurationSchema,
})
export type UpdateBenchmarkSettingsBody = z.infer<typeof updateBenchmarkSettingsBodySchema>

/**
 * A run that left something behind: a session, measurements, or a verdict. Repetitions can only be
 * lowered down to the highest one that started, since dropping it would delete results.
 */
export function startedRepetitions(runs: { repetition: number; conversationId: string | null; status: BenchmarkRunStatus }[]): number {
  return Math.max(0, ...runs.filter((run) => run.conversationId !== null || (run.status !== 'pending' && run.status !== 'cancelled')).map((run) => run.repetition))
}

export const benchmarkRunStatusSchema = z.enum(['pending', 'running', 'checking', 'succeeded', 'failed', 'timed_out', 'cancelled'])
export type BenchmarkRunStatus = z.infer<typeof benchmarkRunStatusSchema>

/** A configuration to measure. The CLI is `config.agent`; without a label, the page names the model. */
export const benchmarkVariantInputSchema = z.object({
  config: agentConfigSchema,
  label: z.string().trim().min(1).max(MAX_BENCHMARK_VARIANT_LABEL_CHARS).optional(),
})
export type BenchmarkVariantInput = z.infer<typeof benchmarkVariantInputSchema>

// --- Comparisons -------------------------------------------------------------------

/** A duel names few contestants: beyond four, outputs no longer fit side by side. */
export const MAX_BENCHMARK_COMPARISON_VARIANTS = 4
export const MAX_BENCHMARK_COMPARISONS = 8
export const MAX_BENCHMARK_COMPARISON_TITLE_CHARS = 80

/**
 * A comparison kept with a benchmark, such as two models of the same range from two vendors.
 * The title is optional: without one, the contestants' names are the title.
 */
export const benchmarkComparisonSchema = z.object({
  id: z.string().min(1).max(40),
  title: z.string().trim().max(MAX_BENCHMARK_COMPARISON_TITLE_CHARS).nullable().default(null),
  variantIds: z.array(z.string().min(1).max(40)).min(2).max(MAX_BENCHMARK_COMPARISON_VARIANTS),
})
export type BenchmarkComparison = z.infer<typeof benchmarkComparisonSchema>
export const benchmarkComparisonsSchema = z.array(benchmarkComparisonSchema).max(MAX_BENCHMARK_COMPARISONS)

export const updateBenchmarkComparisonsBodySchema = z.object({ comparisons: benchmarkComparisonsSchema })
export type UpdateBenchmarkComparisonsBody = z.input<typeof updateBenchmarkComparisonsBodySchema>

/**
 * A comparison carried by a preset or a creation form, before the variants have ids: each
 * contestant is a position in the variant list.
 */
export const benchmarkComparisonDraftSchema = z.object({
  title: z.string().trim().max(MAX_BENCHMARK_COMPARISON_TITLE_CHARS).nullable().default(null),
  variants: z.array(z.number().int().min(0).max(MAX_BENCHMARK_VARIANTS - 1)).min(2).max(MAX_BENCHMARK_COMPARISON_VARIANTS),
})
export type BenchmarkComparisonDraft = z.infer<typeof benchmarkComparisonDraftSchema>

/** Drops what no longer names two distinct, existing contestants. */
export function validComparisonDraft(draft: { variants: number[] }, count: number): boolean {
  const unique = new Set(draft.variants)
  return unique.size === draft.variants.length && unique.size >= 2 && draft.variants.every((index) => index >= 0 && index < count)
}

export const createBenchmarkBodySchema = z.object({
  name: z.string().trim().min(1).max(MAX_BENCHMARK_NAME_CHARS),
  prompt: z.string().trim().min(1).max(MAX_BENCHMARK_PROMPT_CHARS),
  variants: z.array(benchmarkVariantInputSchema).min(1).max(MAX_BENCHMARK_VARIANTS),
  repetitions: benchmarkRepetitionsSchema.default(1),
  concurrency: benchmarkConcurrencyInputSchema.default(1),
  maxDurationMinutes: benchmarkDurationSchema.default(DEFAULT_BENCHMARK_DURATION_MINUTES),
  /** Uploaded, unsent attachments: every run receives them with its first message. */
  attachmentIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
  /**
   * Starting files of an existing benchmark of the same account, copied before the uploads:
   * "new from this benchmark" keeps them without uploading them again.
   */
  inputsFrom: z.string().uuid().nullable().default(null),
  /** Same contract as scheduled checks, minus the skip code: zero passes, anything else fails. */
  checkScript: checkScriptSchema.default(null),
  checkTimeoutSeconds: checkTimeoutSchema.default(DEFAULT_CHECK_TIMEOUT_SECONDS),
  /** Comparisons to keep with the benchmark, by position in `variants`; invalid ones are dropped. */
  comparisons: z.array(benchmarkComparisonDraftSchema).max(MAX_BENCHMARK_COMPARISONS).default([]),
  /** Preset the form was loaded from, so the presets menu can list recently used ones first. */
  presetId: z.string().uuid().nullable().default(null),
})
/** What a client sends: defaults may be omitted. */
export type CreateBenchmarkBody = z.input<typeof createBenchmarkBodySchema>
/** What the route hands the runner once parsed. */
export type CreateBenchmarkData = z.infer<typeof createBenchmarkBodySchema>
export { MAX_CHECK_SCRIPT_CHARS as MAX_BENCHMARK_CHECK_CHARS }

/** A starting file, as frozen with the benchmark. */
export const benchmarkInputSchema = z.object({
  /** Stored file name under the benchmark's directory. */
  storedAs: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
})
export type BenchmarkInput = z.infer<typeof benchmarkInputSchema>
export const benchmarkInputsSchema = z.array(benchmarkInputSchema)

/** Verdict of the benchmark's script in one run's folder. */
export interface BenchmarkCheckResult {
  passed: boolean
  /** Null when the script was killed at its timeout or could not start. */
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  durationMs: number
}

/**
 * How the comparison view renders a produced file. Decided by extension from closed lists, like
 * the panel: guessing from content could render an arbitrary binary as a page.
 */
export type BenchmarkDeliverableKind = 'page' | 'image' | 'audio' | 'video' | 'pdf' | 'text' | 'other'

export interface BenchmarkDeliverable {
  /** Relative to the run folder, slash-separated. */
  path: string
  sizeBytes: number
  kind: BenchmarkDeliverableKind
}

/** Extensions shown as text in the comparison, a few hundred lines at most. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'log',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'php', 'sh', 'bash', 'zsh', 'sql', 'lua', 'r', 'ini',
  'srt', 'vtt',
])

export function deliverableKind(path: string): BenchmarkDeliverableKind {
  const dot = path.lastIndexOf('.')
  const extension = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  if (extension === 'html' || extension === 'htm') return 'page'
  if (VIEWABLE_IMAGE_TYPES[extension]) return 'image'
  const media = VIEWABLE_MEDIA_TYPES[extension]
  if (media) return isAudioType(media) ? 'audio' : 'video'
  if (extension === 'pdf') return 'pdf'
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  return 'other'
}

/** Public, token-scoped prefix of the sandboxed preview route; also exempted by the auth hooks. */
export const BENCHMARK_PREVIEW_PREFIX = '/api/benchmark-previews/'

export function benchmarkPreviewUrl(token: string, path: string): string {
  return `${BENCHMARK_PREVIEW_PREFIX}${token}/${path.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * Variant as frozen in the database: the configuration actually launched, defaults resolved. The
 * array order is the benchmark's order everywhere: tables, charts, shared pages, slides, and the
 * order pending runs launch in.
 */
export const benchmarkVariantSchema = z.object({
  id: z.string(),
  label: z.string(),
  config: agentConfigSchema,
  /** Set on variants added to an existing benchmark, which ran later than the others. */
  addedAt: z.number().int().positive().optional(),
})
export type BenchmarkVariant = z.infer<typeof benchmarkVariantSchema>
export const benchmarkVariantsSchema = z.array(benchmarkVariantSchema)

/**
 * A variant as pages read it. `label` is what to show: the label the user wrote, otherwise the
 * public name of the model that answered, with the effort only when efforts differ within the
 * benchmark. `technicalLabel` keeps the exact model id and effort for a second line or a tooltip.
 */
export interface BenchmarkVariantDto extends BenchmarkVariant {
  technicalLabel: string
  labelIsCustom: boolean
  /** Model the runs announced, or the configured one when it is not an alias; null until known. */
  model: string | null
  /** Public list price of `model`; null when unknown or not listed. */
  listPrice: ModelListPrice | null
  /**
   * Public name of `model` in its short form ("Opus 5.5"), even when the user wrote a label: a
   * form copying this variant names it when its CLI's catalog no longer lists the model.
   */
  publicName: string | null
}

/**
 * The whole ordered lineup of an existing benchmark, as the lineup dialog saves it. Existing
 * variants are named by id and keep their frozen configuration; only their place and label
 * change. Entries with a configuration are new variants, measured on the same prompt and files.
 * Existing ids left out are removed, which deletes their runs once any started: that needs
 * `confirmRemoval`.
 */
export const benchmarkLineupEntrySchema = z.union([
  z.object({
    id: z.string().min(1).max(40),
    /** Null restores the automatic name. */
    label: z.string().trim().min(1).max(MAX_BENCHMARK_VARIANT_LABEL_CHARS).nullable(),
  }),
  z.object({
    config: agentConfigSchema,
    label: z.string().trim().min(1).max(MAX_BENCHMARK_VARIANT_LABEL_CHARS).nullable().default(null),
  }),
])
export type BenchmarkLineupEntry = z.input<typeof benchmarkLineupEntrySchema>

export const updateBenchmarkLineupBodySchema = z.object({
  variants: z.array(benchmarkLineupEntrySchema).min(1).max(MAX_BENCHMARK_TOTAL_VARIANTS),
  confirmRemoval: z.boolean().default(false),
  /**
   * Ids of the lineup the client edited. Removal is inferred from omission, so a save from a tab
   * that never saw a variant added elsewhere would delete it: when the stored ids differ from
   * these, the save is refused instead.
   */
  base: z.array(z.string().min(1).max(40)).max(MAX_BENCHMARK_TOTAL_VARIANTS).optional(),
})
export type UpdateBenchmarkLineupBody = z.input<typeof updateBenchmarkLineupBodySchema>
/** What the route hands the runner once parsed. */
export type UpdateBenchmarkLineupData = z.infer<typeof updateBenchmarkLineupBodySchema>

/**
 * Measurements folded from a run's journal when it settles.
 *
 * `null` means the CLI reported nothing, as opposed to zero: a CLI that never announces token
 * usage must not rank as the cheapest. Counts of journal events are never null because the
 * journal itself is the source.
 */
export interface BenchmarkRunMetrics {
  /** Version of the persisted measurement fold; absent on legacy snapshots. */
  version?: number
  /**
   * Working time from the first user message to the last completed turn; null if no turn
   * completed. The clock stops while a request waits for a human (`waitingMs`) and while the
   * session sits idle between turns; background work the agent started keeps it running.
   */
  durationMs: number | null
  /** Wall time over the same span, waits included. Absent on snapshots folded before it existed. */
  elapsedMs?: number | null
  /** Time spent waiting for a human: permissions, questions, plan reviews, MCP forms. */
  waitingMs: number
  /** Working time, on the same clock as `durationMs`, until the first assistant text; null if none arrived. */
  firstTextMs: number | null
  /** Total input across requests, including cache reads and writes (subsets below). */
  inputTokens: number | null
  /** Includes reasoning tokens when the CLI includes them in its usage. */
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreationTokens: number | null
  /**
   * API-equivalent cost at public list prices as they stand when the benchmark is read, the
   * same computation as the consumption dashboard; null when a model has no public price. On a
   * subscription it is not a charge. The stored snapshot keeps what the CLI announced.
   */
  costUsd: number | null
  toolCalls: number
  /** Calls per tool name, sub-agent calls included. */
  toolsByName: Record<string, number>
  toolErrors: number
  /** Cumulative time inside tools, as reported by the CLI or measured by Sillage. */
  toolDurationMs: number
  /** Assistant messages, one per step: tool rounds count. */
  assistantMessages: number
  /** Characters of assistant text, reasoning excluded. */
  outputChars: number
  /** Context-window usage last reported, null when the CLI reports none. */
  contextTokens: number | null
  /** Model the CLI announced at session start, null before the first announcement. */
  model: string | null
}

export interface BenchmarkRunDto {
  id: string
  variantId: string
  repetition: number
  /** Null until launch, or after its thread was deleted. */
  conversationId: string | null
  status: BenchmarkRunStatus
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  cliVersion: string | null
  metrics: BenchmarkRunMetrics | null
  /** Last assistant text, truncated; null before settlement or when the agent wrote none. */
  response: string | null
  check: BenchmarkCheckResult | null
  files: BenchmarkDeliverable[]
  /** Null before launch. */
  previewToken: string | null
  /** Human rating from 1 to 5; null until rated. */
  rating: number | null
  ratingNote: string | null
  /**
   * Corrections a human sent after the run settled, oldest first. Each one continued the same
   * session, so the measurements add its work to the first attempt's: the list is how a reader
   * tells that the result needed help, and what help.
   */
  followUps: BenchmarkFollowUp[]
}

export interface BenchmarkFollowUp {
  text: string
  sentAt: number
}

export interface BenchmarkDto {
  id: string
  name: string
  prompt: string
  /** In the benchmark's order. */
  variants: BenchmarkVariantDto[]
  /** Saved comparisons, each naming existing variants only. */
  comparisons: BenchmarkComparison[]
  repetitions: number
  concurrency: BenchmarkConcurrency
  maxDurationMinutes: number
  inputs: { filename: string; mimeType: string; sizeBytes: number }[]
  checkScript: string | null
  checkTimeoutSeconds: number
  /** Original this benchmark reruns; null for an original. */
  seriesId: string | null
  createdAt: number
  updatedAt: number
  runs: BenchmarkRunDto[]
}

/** The effort field differs per CLI; benchmarks only need to display it. Null when the CLI has none set. */
export function variantEffort(config: AgentConfig): string | null {
  switch (config.agent) {
    case 'claude':
      return config.effort
    case 'opencode':
      return config.variant || null
    case 'codex':
    case 'grok':
    case 'antigravity':
      return config.reasoningEffort || null
  }
}

/** Default label: what distinguishes variants in practice, without repeating the CLI shown by its icon. */
export function defaultVariantLabel(config: AgentConfig): string {
  const effort = variantEffort(config)
  const model = config.model || 'default'
  return effort ? `${model} · ${effort}` : model
}

/**
 * A label left at its default names what was configured, often a CLI alias ("sonnet") or no
 * model at all ("default"). Once a run announced the model that answered, name that one:
 * it is the fact a reader compares. A label the user wrote is theirs and stays.
 */
export function announcedVariantLabel(variant: { label: string; config: AgentConfig }, announcedModel: string | null): string {
  if (!announcedModel || variant.label !== defaultVariantLabel(variant.config)) return variant.label
  return defaultVariantLabel({ ...variant.config, model: announcedModel })
}

/** Stored labels equal to the default were never written by the user. */
export function isCustomVariantLabel(variant: { label: string; config: AgentConfig }): boolean {
  return variant.label !== defaultVariantLabel(variant.config)
}

/**
 * Public names arrive as the reference list spells them ("Claude Opus 5.5"). Beside the CLI's
 * logo, the Claude prefix repeats what the logo says; other vendors put the family in the name
 * itself ("GPT-6.1 Terra", "Gemini 4 Argon") and keep it.
 */
export function shortModelName(name: string): string {
  const trimmed = name.trim()
  const short = trimmed.replace(/^Claude\s+(?=\S)/, '')
  return short || trimmed
}

/**
 * Name shown for a variant: what the user wrote, otherwise the public name of the model, with the
 * effort only when the benchmark's variants differ by effort (repeating "medium" on every name of
 * a lineup that all ran at medium is noise). Without a public name, the technical label stands.
 */
export function variantDisplayLabel(
  variant: { label: string; config: AgentConfig },
  technicalLabel: string,
  publicName: string | null,
  effortsDiffer: boolean,
): string {
  if (isCustomVariantLabel(variant)) return variant.label
  if (!publicName) return technicalLabel
  const effort = variantEffort(variant.config)
  return effortsDiffer && effort ? `${shortModelName(publicName)} · ${effort}` : shortModelName(publicName)
}

/** Whether a lineup mixes efforts, which is when names must carry them. */
export function lineupEffortsDiffer(configs: AgentConfig[]): boolean {
  return new Set(configs.map((config) => variantEffort(config) ?? '')).size > 1
}

/**
 * Next free variant id across a whole series. Reruns copy ids, and a variant added to one member
 * must never take an id another member gives to a different configuration.
 */
export function nextVariantIndex(ids: Iterable<string>): number {
  let highest = 0
  for (const id of ids) {
    const match = /^v(\d+)$/.exec(id)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return highest + 1
}

export function variantAgent(variant: { config: AgentConfig }): AgentKind {
  return variant.config.agent
}

export function benchmarkPath(id: string): string {
  return `/benchmarks/${id}`
}

export const MIN_BENCHMARK_RATING = 1
export const MAX_BENCHMARK_RATING = 5
export const MAX_BENCHMARK_RATING_NOTE_CHARS = 2000

/** `rating: null` clears it: a blind pass can be redone. */
export const rateBenchmarkRunBodySchema = z.object({
  rating: z.number().int().min(MIN_BENCHMARK_RATING).max(MAX_BENCHMARK_RATING).nullable(),
  note: z.string().trim().max(MAX_BENCHMARK_RATING_NOTE_CHARS).nullable().default(null),
})
export type RateBenchmarkRunBody = z.input<typeof rateBenchmarkRunBodySchema>

/** A follow-up continues settled runs: those whose session could still answer. */
export const BENCHMARK_FOLLOW_UP_STATUSES: readonly BenchmarkRunStatus[] = ['succeeded', 'failed', 'timed_out']

export function canFollowUp(run: Pick<BenchmarkRunDto, 'status' | 'conversationId'>): boolean {
  return run.conversationId !== null && BENCHMARK_FOLLOW_UP_STATUSES.includes(run.status)
}

/** One text sent to several runs at once: the same correction for every model that needs it. */
export const followUpBenchmarkRunsBodySchema = z.object({
  runIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_BENCHMARK_TOTAL_VARIANTS * MAX_BENCHMARK_REPETITIONS),
  text: z.string().trim().min(1).max(MAX_BENCHMARK_PROMPT_CHARS),
})
export type FollowUpBenchmarkRunsBody = z.input<typeof followUpBenchmarkRunsBodySchema>

/** Root of the series a benchmark belongs to: itself for an original. */
export function benchmarkSeriesRoot(benchmark: { id: string; seriesId: string | null }): string {
  return benchmark.seriesId ?? benchmark.id
}

// --- Presets -----------------------------------------------------------------------

export const MAX_BENCHMARK_PRESETS = 50
export const MAX_BENCHMARK_PRESET_NAME_CHARS = 80

/**
 * A saved starting point for the creation form: the lineup in its order, how much it runs, the
 * comparisons between its variants, and optionally the prompt and check script. Starting files
 * are not kept: "new from this benchmark" copies them instead. Personal, like benchmarks, and
 * written only from the account's own interface, since a check script runs without approval.
 */
export const benchmarkPresetBodySchema = z.object({
  name: z.string().trim().min(1).max(MAX_BENCHMARK_PRESET_NAME_CHARS),
  variants: z.array(benchmarkVariantInputSchema).min(1).max(MAX_BENCHMARK_VARIANTS),
  repetitions: benchmarkRepetitionsSchema,
  concurrency: benchmarkConcurrencySchema,
  maxDurationMinutes: benchmarkDurationSchema,
  comparisons: z.array(benchmarkComparisonDraftSchema).max(MAX_BENCHMARK_COMPARISONS).default([]),
  prompt: z.string().trim().min(1).max(MAX_BENCHMARK_PROMPT_CHARS).nullable().default(null),
  checkScript: checkScriptSchema.default(null),
  checkTimeoutSeconds: checkTimeoutSchema.default(DEFAULT_CHECK_TIMEOUT_SECONDS),
})
export type BenchmarkPresetBody = z.input<typeof benchmarkPresetBodySchema>
export type BenchmarkPresetData = z.infer<typeof benchmarkPresetBodySchema>

/**
 * A stored variant read back leniently: a configuration saved months ago may name an option a
 * CLI has since dropped. Such a variant comes back without a config, flagged, instead of failing
 * the whole list or silently changing.
 */
export interface BenchmarkPresetVariantDto {
  config: AgentConfig | null
  /** CLI of the stored configuration, known even when the configuration no longer parses. */
  agent: AgentKind | null
  label: string | null
  problem: 'invalid_config' | null
  /**
   * The configured model when the public reference lists know it (aliases such as `opus` are
   * not models), with its short public name and list price. The form falls back on them when the
   * CLI's own catalog does not list the model, an older CLI for instance.
   */
  model: string | null
  publicName: string | null
  listPrice: ModelListPrice | null
}

export interface BenchmarkPresetDto {
  id: string
  name: string
  variants: BenchmarkPresetVariantDto[]
  repetitions: number
  concurrency: number
  maxDurationMinutes: number
  comparisons: BenchmarkComparisonDraft[]
  prompt: string | null
  checkScript: string | null
  checkTimeoutSeconds: number
  createdAt: number
  updatedAt: number
  /** Last benchmark launched from it; null when never used. */
  lastUsedAt: number | null
}

// --- Sharing -----------------------------------------------------------------------

/**
 * How much of a run can be shown outside Sillage. `page`: a static page that works from plain
 * files. `files`: no page, but media or text a browser displays. `none`: nothing to embed, the
 * measurements and the final response still go on the shared page.
 */
export type BenchmarkExportMode = 'page' | 'files' | 'none'

/**
 * Why a run's production is left out. `build`: sources that need a bundler or dev server.
 * `server`: needs a backend running. `empty`: the folder holds nothing a browser displays.
 * `missing`: the run's folder or thread is gone. `too_large`: over the snapshot limits.
 * `unfinished`: the run has not settled.
 */
export type BenchmarkExportBlocker = 'build' | 'server' | 'empty' | 'missing' | 'too_large' | 'unfinished'

export interface BenchmarkRunExportability {
  runId: string
  mode: BenchmarkExportMode
  reason: BenchmarkExportBlocker | null
  /** Page opened first, relative to the run folder; null unless `mode` is `page`. */
  entry: string | null
  /** Files and bytes a snapshot would copy. */
  files: number
  bytes: number
}

/** A snapshot stays small enough to copy on every publication and to send to a friend's phone. */
export const MAX_BENCHMARK_SHARE_RUN_FILES = 2000
export const MAX_BENCHMARK_SHARE_RUN_BYTES = 150 * 1024 * 1024
/** Across all runs of one publication or archive. */
export const MAX_BENCHMARK_SHARE_BYTES = 500 * 1024 * 1024
export const MAX_BENCHMARK_SHARE_NOTE_CHARS = 2000

export const benchmarkShareOptionsSchema = z.object({
  title: z.string().trim().min(1).max(MAX_BENCHMARK_NAME_CHARS),
  /** Free introduction shown under the title. */
  note: z.string().trim().max(MAX_BENCHMARK_SHARE_NOTE_CHARS).default(''),
  includePrompt: z.boolean().default(true),
  includeResponses: z.boolean().default(true),
  includeMetrics: z.boolean().default(true),
  includeRatings: z.boolean().default(false),
  /** The chart of one measure across variants, next to the table; needs the measurements. */
  includeChart: z.boolean().default(true),
  /** A slideshow beside the page (`slides.html`), for screen sharing and recording. */
  includeSlides: z.boolean().default(true),
  /**
   * Saved comparisons featured on the page and as slides, by id; null features all of them.
   * Readers can still compare any variants themselves.
   */
  comparisons: z.array(z.string().min(1).max(40)).max(MAX_BENCHMARK_COMPARISONS).nullable().default(null),
  /** Variants shown as letters until the reader reveals them: a guessing game, not a secret. */
  blind: z.boolean().default(false),
  /** In blind slides, reveal each model right after its production, or all of them at the end. */
  revealAt: z.enum(['each', 'end']).default('each'),
  locale: z.enum(['en', 'fr']).default('en'),
})
export type BenchmarkShareOptions = z.infer<typeof benchmarkShareOptionsSchema>

export const publishBenchmarkShareBodySchema = benchmarkShareOptionsSchema.extend({
  /** Null for a link that never expires. */
  expiresAt: z.number().int().positive().nullable(),
})
export type PublishBenchmarkShareBody = z.input<typeof publishBenchmarkShareBodySchema>

export interface BenchmarkShareDto {
  id: string
  title: string
  /** Null when the instance no longer has a public address. */
  url: string | null
  createdAt: number
  expiresAt: number | null
  /** Last time the page was regenerated under the same address; null if never. */
  refreshedAt: number | null
  /**
   * Links keep the options they were published with, so they can be regenerated after the
   * benchmark changed. Links published before that have none and can only be replaced.
   */
  refreshable: boolean
}

export interface BenchmarkShareStateDto {
  /** Public links need the Server edition and a public address; the archive always works. */
  canPublish: boolean
  runs: BenchmarkRunExportability[]
  shares: BenchmarkShareDto[]
}

/** Public prefix of shared benchmarks, under the `/s/` space already excluded from the app shell. */
export const BENCHMARK_SHARE_PREFIX = '/s/b/'

/** The slideshow's file beside `index.html`, in a published snapshot and in the archive. */
export const BENCHMARK_SLIDES_FILE = 'slides.html'

/**
 * The owner's live renderings of the shared page and of the slideshow: the same documents as a
 * publication, over the run folders instead of a copy. Under `/api/` so the app's service worker
 * never answers them with the app shell, and cookie-only like every benchmark route.
 */
export function benchmarkLiveUrl(benchmarkId: string, document: 'page' | 'slides', options: BenchmarkShareOptions): string {
  return `/api/benchmarks/${encodeURIComponent(benchmarkId)}/live/${document}?options=${encodeURIComponent(JSON.stringify(options))}`
}
