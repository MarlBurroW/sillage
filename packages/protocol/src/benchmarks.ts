import { z } from 'zod'
import { agentConfigSchema, type AgentConfig } from './agent-config.js'
import { MAX_ATTACHMENTS_PER_MESSAGE, VIEWABLE_IMAGE_TYPES, VIEWABLE_MEDIA_TYPES, isAudioType } from './api.js'
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
/** Enough to cross three CLIs with a few efforts each; more would exhaust a subscription's window. */
export const MAX_BENCHMARK_VARIANTS = 12
export const MAX_BENCHMARK_REPETITIONS = 5
export const MIN_BENCHMARK_DURATION_MINUTES = 1
export const MAX_BENCHMARK_DURATION_MINUTES = 4 * 60
/** A benchmark prompt is a bounded task: an agent still busy after this is wandering. */
export const DEFAULT_BENCHMARK_DURATION_MINUTES = 20
/**
 * Simultaneous sessions a parallel benchmark may keep open. Twelve CLIs at once would starve
 * each other on one machine and distort every duration they report.
 */
export const MAX_PARALLEL_BENCHMARK_RUNS = 4

export const benchmarkConcurrencySchema = z.enum(['sequential', 'parallel'])
export type BenchmarkConcurrency = z.infer<typeof benchmarkConcurrencySchema>

export const benchmarkRunStatusSchema = z.enum(['pending', 'running', 'checking', 'succeeded', 'failed', 'timed_out', 'cancelled'])
export type BenchmarkRunStatus = z.infer<typeof benchmarkRunStatusSchema>

/** A configuration to measure. The CLI is `config.agent`; the label defaults to model and effort. */
export const benchmarkVariantInputSchema = z.object({
  config: agentConfigSchema,
  label: z.string().trim().min(1).max(MAX_BENCHMARK_VARIANT_LABEL_CHARS).optional(),
})
export type BenchmarkVariantInput = z.infer<typeof benchmarkVariantInputSchema>

export const createBenchmarkBodySchema = z.object({
  name: z.string().trim().min(1).max(MAX_BENCHMARK_NAME_CHARS),
  prompt: z.string().trim().min(1).max(MAX_BENCHMARK_PROMPT_CHARS),
  variants: z.array(benchmarkVariantInputSchema).min(1).max(MAX_BENCHMARK_VARIANTS),
  repetitions: z.number().int().min(1).max(MAX_BENCHMARK_REPETITIONS).default(1),
  concurrency: benchmarkConcurrencySchema.default('sequential'),
  maxDurationMinutes: z
    .number()
    .int()
    .min(MIN_BENCHMARK_DURATION_MINUTES)
    .max(MAX_BENCHMARK_DURATION_MINUTES)
    .default(DEFAULT_BENCHMARK_DURATION_MINUTES),
  /** Uploaded, unsent attachments: every run receives them with its first message. */
  attachmentIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
  /** Same contract as scheduled checks, minus the skip code: zero passes, anything else fails. */
  checkScript: checkScriptSchema.default(null),
  checkTimeoutSeconds: checkTimeoutSchema.default(DEFAULT_CHECK_TIMEOUT_SECONDS),
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

/** Variant as frozen in the database: the configuration actually launched, defaults resolved. */
export const benchmarkVariantSchema = z.object({
  id: z.string(),
  label: z.string(),
  config: agentConfigSchema,
})
export type BenchmarkVariant = z.infer<typeof benchmarkVariantSchema>
export const benchmarkVariantsSchema = z.array(benchmarkVariantSchema)

/**
 * Measurements folded from a run's journal when it settles.
 *
 * `null` means the CLI reported nothing, as opposed to zero: a CLI that never announces token
 * usage must not rank as the cheapest. Counts of journal events are never null because the
 * journal itself is the source.
 */
export interface BenchmarkRunMetrics {
  /**
   * From the first user message to the last completed turn; null if the turn never completed.
   * Wall time: it includes `waitingMs`, the time a request for permission or an answer stayed open.
   */
  durationMs: number | null
  /** Time spent waiting for a human: permissions, questions, plan reviews, MCP forms. */
  waitingMs: number
  /** From the first user message to the first assistant text; null if none arrived. */
  firstTextMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreationTokens: number | null
  /** API-equivalent cost computed by the CLI; on a subscription it is not a charge. */
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
}

export interface BenchmarkDto {
  id: string
  name: string
  prompt: string
  variants: BenchmarkVariant[]
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

/** Root of the series a benchmark belongs to: itself for an original. */
export function benchmarkSeriesRoot(benchmark: { id: string; seriesId: string | null }): string {
  return benchmark.seriesId ?? benchmark.id
}
