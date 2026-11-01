import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import {
  MAX_BENCHMARK_RATING,
  benchmarkSeriesRoot,
  variantAgent,
  variantEffort,
  type BenchmarkDto,
  type BenchmarkRunDto,
  type CreateBenchmarkBody,
  type RateBenchmarkRunBody,
} from '@sillage/protocol'
import { api } from './api'
import { toCsv } from './download'
import type { MessageKey } from './i18n'

export const BENCHMARKS_KEY = ['benchmarks']

/** Not settled yet: waiting, working, or under its check script. */
export function isOpenRun(run: BenchmarkRunDto): boolean {
  return run.status === 'pending' || run.status === 'running' || run.status === 'checking'
}

function hasOpenRuns(benchmarks: BenchmarkDto[] | undefined): boolean {
  return benchmarks?.some((benchmark) => benchmark.runs.some(isOpenRun)) ?? false
}

/**
 * The account's benchmarks with their runs. Poll only while something runs: measurements land when
 * sessions settle, outside any interface request, and a finished benchmark never changes.
 */
export function useBenchmarks() {
  return useQuery({
    queryKey: BENCHMARKS_KEY,
    queryFn: () => api.get<BenchmarkDto[]>('/api/benchmarks'),
    staleTime: 5_000,
    refetchInterval: (query) => (hasOpenRuns(query.state.data) ? 4_000 : false),
  })
}

function useInvalidate() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: BENCHMARKS_KEY })
    // Launching or deleting runs changes the discussion list too.
    void queryClient.invalidateQueries({ queryKey: ['conversations'] })
  }
}

export function useCreateBenchmark() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: CreateBenchmarkBody) => api.post<BenchmarkDto>('/api/benchmarks', input),
    onSuccess: invalidate,
  })
}

export function useCancelBenchmark() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.post<BenchmarkDto>(`/api/benchmarks/${id}/cancel`),
    onSuccess: invalidate,
  })
}

export function useDeleteBenchmark() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/benchmarks/${id}`),
    onSuccess: invalidate,
  })
}

/** Repeats a benchmark as it was; the copy joins the original's series. */
export function useRerunBenchmark() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.post<BenchmarkDto>(`/api/benchmarks/${id}/rerun`),
    onSuccess: invalidate,
  })
}

/**
 * Ratings apply to the cached list before the server answers: a blind pass rates several runs in
 * a row, and stars must not lag. Only the rated run is patched, from the click and then from the
 * reply: replacing the whole benchmark would let an earlier, slower reply erase a later rating.
 */
export function useRateBenchmarkRun(benchmarkId: string) {
  const queryClient = useQueryClient()
  const patch = (runId: string, change: Partial<BenchmarkRunDto>) =>
    queryClient.setQueryData<BenchmarkDto[]>(BENCHMARKS_KEY, (list) => list?.map((entry) => (entry.id !== benchmarkId ? entry : {
      ...entry,
      runs: entry.runs.map((run) => (run.id === runId ? { ...run, ...change } : run)),
    })))
  return useMutation({
    mutationFn: ({ runId, ...body }: RateBenchmarkRunBody & { runId: string }) =>
      api.put<BenchmarkDto>(`/api/benchmarks/${benchmarkId}/runs/${runId}/rating`, body),
    onMutate: ({ runId, rating, note }) => patch(runId, { rating, ratingNote: rating === null ? null : (note ?? null) }),
    onSuccess: (updated, { runId }) => {
      const run = updated.runs.find((entry) => entry.id === runId)
      if (run) patch(runId, { rating: run.rating, ratingNote: run.ratingNote })
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: BENCHMARKS_KEY }),
  })
}

/** Benchmarks of one series, oldest first: the original, then its reruns. */
export function benchmarkSeries(all: BenchmarkDto[], benchmark: BenchmarkDto): BenchmarkDto[] {
  const root = benchmarkSeriesRoot(benchmark)
  return all.filter((entry) => benchmarkSeriesRoot(entry) === root).sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Blind review of one benchmark: variants shuffled and named by letter until revealed. Kept in
 * local storage so a reload mid-review keeps the same letters, which a rating may refer to. The
 * shuffle is per device: ratings are what the server keeps, never the mapping.
 */
interface BlindState {
  seed: number
  revealed: boolean
}

const blindKey = (benchmarkId: string) => `sillage.benchmark.blind.${benchmarkId}`

function readBlind(benchmarkId: string): BlindState | null {
  try {
    const raw = localStorage.getItem(blindKey(benchmarkId))
    return raw ? (JSON.parse(raw) as BlindState) : null
  } catch {
    return null
  }
}

/** Deterministic shuffle: the same seed always gives the same order. */
function shuffled<T>(items: T[], seed: number): T[] {
  const copy = [...items]
  let state = seed || 1
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648
    const other = state % (index + 1)
    ;[copy[index], copy[other]] = [copy[other]!, copy[index]!]
  }
  return copy
}

export function useBlindReview(benchmarkId: string, variantIds: string[]) {
  const [state, setState] = useState<BlindState | null>(() => readBlind(benchmarkId))
  const write = useCallback((next: BlindState | null) => {
    setState(next)
    if (next) localStorage.setItem(blindKey(benchmarkId), JSON.stringify(next))
    else localStorage.removeItem(blindKey(benchmarkId))
  }, [benchmarkId])
  const active = state !== null && !state.revealed
  const order = useMemo(() => (state ? shuffled(variantIds, state.seed) : variantIds), [state, variantIds])
  return {
    /** Variant names and settings are hidden. */
    active,
    /** A blind pass happened and was revealed: letters stay shown next to the names. */
    revealed: state?.revealed === true,
    /** Variant ids in display order while blind or revealed, original order otherwise. */
    order,
    letterOf: (variantId: string) => (state ? String.fromCharCode(65 + order.indexOf(variantId)) : null),
    start: () => write({ seed: Math.floor(Math.random() * 2147483647) + 1, revealed: false }),
    reveal: () => state && write({ ...state, revealed: true }),
    reset: () => write(null),
  }
}

/** One-word benchmark activity for rows and badges. */
export type BenchmarkState = 'running' | 'done' | 'failed' | 'cancelled'

export const BENCHMARK_STATE_LABELS: Record<BenchmarkState, MessageKey> = {
  running: 'benchmark.state.running',
  done: 'benchmark.state.done',
  failed: 'benchmark.state.failed',
  cancelled: 'benchmark.state.cancelled',
}

export function benchmarkState(benchmark: BenchmarkDto): BenchmarkState {
  const runs = benchmark.runs
  if (runs.some(isOpenRun)) return 'running'
  if (runs.some((run) => run.status === 'cancelled')) return 'cancelled'
  if (runs.some((run) => run.status === 'failed' || run.status === 'timed_out')) return 'failed'
  return 'done'
}

/** Settled runs over total, for progress labels. */
export function benchmarkProgress(benchmark: BenchmarkDto): { done: number; total: number } {
  const done = benchmark.runs.filter((run) => !isOpenRun(run)).length
  return { done, total: benchmark.runs.length }
}

export const RUN_STATUS_LABELS: Record<BenchmarkRunDto['status'], MessageKey> = {
  pending: 'benchmark.run.pending',
  running: 'benchmark.run.running',
  checking: 'benchmark.run.checking',
  succeeded: 'benchmark.run.succeeded',
  failed: 'benchmark.run.failed',
  timed_out: 'benchmark.run.timedOut',
  cancelled: 'benchmark.run.cancelled',
}

/** Measurements shown as table columns, in reading order. Each reads one number from the metrics. */
export type MetricKey =
  | 'rating'
  | 'durationMs'
  | 'waitingMs'
  | 'firstTextMs'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheCreationTokens'
  | 'costUsd'
  | 'toolCalls'
  | 'toolErrors'
  | 'toolDurationMs'
  | 'assistantMessages'
  | 'outputChars'
  | 'contextTokens'

export const METRIC_KEYS: MetricKey[] = [
  'rating',
  'durationMs',
  'waitingMs',
  'firstTextMs',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'costUsd',
  'toolCalls',
  'toolErrors',
  'toolDurationMs',
  'assistantMessages',
  'outputChars',
  'contextTokens',
]

export const METRIC_LABELS: Record<MetricKey, MessageKey> = {
  rating: 'benchmark.metric.rating',
  durationMs: 'benchmark.metric.duration',
  waitingMs: 'benchmark.metric.waiting',
  firstTextMs: 'benchmark.metric.firstText',
  inputTokens: 'benchmark.metric.inputTokens',
  outputTokens: 'benchmark.metric.outputTokens',
  cacheReadTokens: 'benchmark.metric.cacheRead',
  cacheCreationTokens: 'benchmark.metric.cacheWrite',
  costUsd: 'benchmark.metric.cost',
  toolCalls: 'benchmark.metric.toolCalls',
  toolErrors: 'benchmark.metric.toolErrors',
  toolDurationMs: 'benchmark.metric.toolDuration',
  assistantMessages: 'benchmark.metric.messages',
  outputChars: 'benchmark.metric.outputChars',
  contextTokens: 'benchmark.metric.context',
}

export function metricValue(run: BenchmarkRunDto, key: MetricKey): number | null {
  if (key === 'rating') return run.rating
  if (!run.metrics) return null
  // Measurements folded before a field existed read as unreported rather than undefined.
  return run.metrics[key] ?? null
}

/**
 * Columns worth showing for this benchmark. Human waiting appears only when a run waited: in a
 * clean benchmark it would be a column of zeros pushing the useful ones off screen.
 */
export function visibleMetricKeys(benchmark: BenchmarkDto): MetricKey[] {
  const waited = benchmark.runs.some((run) => (run.metrics?.waitingMs ?? 0) > 0)
  const rated = benchmark.runs.some((run) => run.rating !== null)
  return METRIC_KEYS.filter((key) => (key !== 'waitingMs' || waited) && (key !== 'rating' || rated))
}

/** Human formatting per unit. Null stays a dash: an unreported value must not read as zero. */
export function formatMetric(key: MetricKey, value: number | null, locale: string): string {
  if (value === null) return '—'
  switch (key) {
    case 'rating':
      return `${value.toLocaleString(locale, { maximumFractionDigits: 1 })}/${MAX_BENCHMARK_RATING}`
    case 'durationMs':
    case 'waitingMs':
    case 'firstTextMs':
    case 'toolDurationMs':
      return formatDuration(value, locale)
    case 'costUsd':
      return value.toLocaleString(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 3 : 2 })
    default:
      return value.toLocaleString(locale, { maximumFractionDigits: 0 })
  }
}

export function formatDuration(ms: number, locale: string): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toLocaleString(locale, { maximumFractionDigits: 1 })} s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return `${minutes} min ${String(rest).padStart(2, '0')} s`
}

/** Median of reported values; null when nothing was reported. Medians resist one slow outlier better than means. */
export function median(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null).sort((a, b) => a - b)
  if (known.length === 0) return null
  const middle = Math.floor(known.length / 2)
  return known.length % 2 === 1 ? known[middle]! : (known[middle - 1]! + known[middle]!) / 2
}

/** Smallest and largest reported values, for the spread under a median. Null below two values. */
export function spread(values: (number | null)[]): { min: number; max: number } | null {
  const known = values.filter((value): value is number => value !== null)
  if (known.length < 2) return null
  return { min: Math.min(...known), max: Math.max(...known) }
}

/** Runs whose script ran, and how many passed. Null when the benchmark has no script. */
export function passRate(benchmark: BenchmarkDto, runs: BenchmarkRunDto[]): { passed: number; checked: number } | null {
  if (!benchmark.checkScript) return null
  const checked = runs.filter((run) => run.check !== null)
  return { passed: checked.filter((run) => run.check?.passed).length, checked: checked.length }
}

/** File-system-safe stem for exports: the benchmark name, or its id when nothing survives. */
function exportStem(benchmark: BenchmarkDto): string {
  const stem = benchmark.name.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return stem || benchmark.id
}

/**
 * One row per run with raw numbers, for a spreadsheet or a notebook. Units stay in column names
 * (`_ms`, `_usd`) rather than in cells, and unreported values stay empty rather than zero.
 */
export function benchmarkCsv(benchmark: BenchmarkDto): { filename: string; content: string } {
  const header = [
    'benchmark', 'variant', 'agent', 'model', 'effort', 'announced_model', 'cli_version', 'repetition', 'status',
    'check_passed', 'check_exit_code', 'duration_ms', 'waiting_ms', 'first_text_ms', 'input_tokens', 'output_tokens',
    'cache_read_tokens', 'cache_creation_tokens', 'cost_usd', 'tool_calls', 'tool_errors', 'tool_duration_ms',
    'assistant_messages', 'output_chars', 'context_tokens', 'rating', 'rating_note', 'error',
  ]
  const cell = (value: number | string | boolean | null | undefined) => (value === null || value === undefined ? '' : String(value))
  const rows = benchmark.runs.map((run) => {
    const variant = benchmark.variants.find((entry) => entry.id === run.variantId)
    const m = run.metrics
    return [
      benchmark.name, variant?.label, variant ? variantAgent(variant) : '', variant?.config.model,
      variant ? variantEffort(variant.config) : '', m?.model, run.cliVersion, run.repetition, run.status,
      run.check ? run.check.passed : null, run.check?.exitCode, m?.durationMs, m?.waitingMs, m?.firstTextMs, m?.inputTokens,
      m?.outputTokens, m?.cacheReadTokens, m?.cacheCreationTokens, m?.costUsd, m?.toolCalls, m?.toolErrors,
      m?.toolDurationMs, m?.assistantMessages, m?.outputChars, m?.contextTokens, run.rating, run.ratingNote, run.error,
    ].map(cell)
  })
  return { filename: `${exportStem(benchmark)}.csv`, content: toCsv([header, ...rows]) }
}

/** Everything the page knows, minus the preview capabilities: an export may travel. */
export function benchmarkJson(benchmark: BenchmarkDto): { filename: string; content: string } {
  const runs = benchmark.runs.map(({ previewToken: _token, ...run }) => run)
  return { filename: `${exportStem(benchmark)}.json`, content: JSON.stringify({ ...benchmark, runs }, null, 2) }
}
