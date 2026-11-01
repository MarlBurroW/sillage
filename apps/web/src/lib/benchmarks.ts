import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BenchmarkDto, BenchmarkRunDto, BenchmarkRunMetrics, CreateBenchmarkBody } from '@sillage/protocol'
import { api } from './api'
import type { MessageKey } from './i18n'

export const BENCHMARKS_KEY = ['benchmarks']

function hasOpenRuns(benchmarks: BenchmarkDto[] | undefined): boolean {
  return benchmarks?.some((benchmark) => benchmark.runs.some((run) => run.status === 'pending' || run.status === 'running')) ?? false
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
  if (runs.some((run) => run.status === 'pending' || run.status === 'running')) return 'running'
  if (runs.some((run) => run.status === 'cancelled')) return 'cancelled'
  if (runs.some((run) => run.status === 'failed' || run.status === 'timed_out')) return 'failed'
  return 'done'
}

/** Settled runs over total, for progress labels. */
export function benchmarkProgress(benchmark: BenchmarkDto): { done: number; total: number } {
  const done = benchmark.runs.filter((run) => run.status !== 'pending' && run.status !== 'running').length
  return { done, total: benchmark.runs.length }
}

export const RUN_STATUS_LABELS: Record<BenchmarkRunDto['status'], MessageKey> = {
  pending: 'benchmark.run.pending',
  running: 'benchmark.run.running',
  succeeded: 'benchmark.run.succeeded',
  failed: 'benchmark.run.failed',
  timed_out: 'benchmark.run.timedOut',
  cancelled: 'benchmark.run.cancelled',
}

/** Measurements shown as table columns, in reading order. Each reads one number from the metrics. */
export type MetricKey =
  | 'durationMs'
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
  'durationMs',
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
  durationMs: 'benchmark.metric.duration',
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

export function metricValue(metrics: BenchmarkRunMetrics | null, key: MetricKey): number | null {
  if (!metrics) return null
  return metrics[key]
}

/** Human formatting per unit. Null stays a dash: an unreported value must not read as zero. */
export function formatMetric(key: MetricKey, value: number | null, locale: string): string {
  if (value === null) return '—'
  switch (key) {
    case 'durationMs':
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
