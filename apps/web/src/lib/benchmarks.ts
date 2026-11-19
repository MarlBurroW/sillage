import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  BENCHMARK_METRIC_KEYS,
  MAX_BENCHMARK_RATING,
  benchmarkLiveUrl,
  benchmarkMetricValue,
  benchmarkSeriesRoot,
  benchmarkShareOptionsSchema,
  eligibleRuns,
  median,
  variantAgent,
  variantEffort,
  type BenchmarkDto,
  type BenchmarkMetricKey,
  type BenchmarkPresetBody,
  type BenchmarkPresetDto,
  type BenchmarkRunDto,
  type BenchmarkShareDto,
  type BenchmarkShareOptions,
  type BenchmarkShareStateDto,
  type CreateBenchmarkBody,
  type FollowUpBenchmarkRunsBody,
  type PublishBenchmarkShareBody,
  type RateBenchmarkRunBody,
  type UpdateBenchmarkComparisonsBody,
  type UpdateBenchmarkLineupBody,
  type UpdateBenchmarkSettingsBody,
} from '@sillage/protocol'
import { api } from './api'
import { liveStatus, subscribeStatus } from './conversation-status'
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

/** A run whose CLI asked something: it stalls, and so does its benchmark when runs are sequential. */
export interface WaitingRun {
  benchmark: BenchmarkDto
  run: BenchmarkRunDto & { conversationId: string }
}

/**
 * Runs blocked on a request from their CLI, across benchmarks or within one. Their own pages are
 * not where the user looks during a long run, so the navigation and the benchmark page all read
 * this one list. Statuses come live from the socket, which sends them for every live session on
 * connection: a reload still finds the wait.
 */
export function useWaitingRuns(benchmarks: BenchmarkDto[] | undefined): WaitingRun[] {
  const candidates = useMemo(() => (benchmarks ?? []).flatMap((benchmark) => benchmark.runs.flatMap((run) =>
    run.status === 'running' && run.conversationId ? [{ benchmark, run: { ...run, conversationId: run.conversationId } }] : [])), [benchmarks])
  // A string of flags: a primitive snapshot does not render on every token of a working run.
  const snapshot = () => candidates.map((entry) => (liveStatus(entry.run.conversationId) === 'awaiting_input' ? '1' : '0')).join('')
  const flags = useSyncExternalStore(subscribeStatus, snapshot, snapshot)
  return useMemo(() => candidates.filter((_, index) => flags[index] === '1'), [candidates, flags])
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

/** Repetitions, slots and duration stay adjustable after launch; the server refuses to drop started runs. */
export function useUpdateBenchmarkSettings() {
  const queryClient = useQueryClient()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, settings }: { id: string; settings: UpdateBenchmarkSettingsBody }) =>
      api.put<BenchmarkDto>(`/api/benchmarks/${id}/settings`, settings),
    onSuccess: (saved) => {
      // The dialog closes on success: show what was saved at once, not the old values until the refetch.
      queryClient.setQueryData<BenchmarkDto[]>(BENCHMARKS_KEY, (list) => list?.map((benchmark) => (benchmark.id === saved.id ? saved : benchmark)))
      invalidate()
    },
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
  const queryClient = useQueryClient()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/benchmarks/${id}`),
    onSuccess: (_, id) => {
      // The index opens the first benchmark of the list: drop this one before the refetch answers,
      // or leaving the deleted page would lead straight back to it.
      queryClient.setQueryData<BenchmarkDto[]>(BENCHMARKS_KEY, (list) => list?.filter((benchmark) => benchmark.id !== id))
      invalidate()
    },
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

/** Puts a saved benchmark in the cached list at once: dialogs close on success. */
function usePatchBenchmark() {
  const queryClient = useQueryClient()
  return (saved: BenchmarkDto) =>
    queryClient.setQueryData<BenchmarkDto[]>(BENCHMARKS_KEY, (list) => list?.map((benchmark) => (benchmark.id === saved.id ? saved : benchmark)))
}

/**
 * Saves the whole ordered lineup of an existing benchmark: order, names, new variants (which
 * queue their own runs) and removals. Settings of variants that ran stay frozen on the server.
 */
export function useUpdateBenchmarkLineup() {
  const patch = usePatchBenchmark()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, lineup }: { id: string; lineup: UpdateBenchmarkLineupBody }) =>
      api.put<BenchmarkDto>(`/api/benchmarks/${id}/lineup`, lineup),
    onSuccess: (saved) => {
      patch(saved)
      invalidate()
    },
  })
}

/** Replaces the comparisons kept with a benchmark. */
export function useUpdateBenchmarkComparisons() {
  const patch = usePatchBenchmark()
  return useMutation({
    mutationFn: ({ id, comparisons }: { id: string; comparisons: UpdateBenchmarkComparisonsBody['comparisons'] }) =>
      api.put<BenchmarkDto>(`/api/benchmarks/${id}/comparisons`, { comparisons }),
    onSuccess: patch,
  })
}

const PRESETS_KEY = ['benchmark-presets']

/** The account's presets, recently used first. */
export function useBenchmarkPresets(enabled = true) {
  return useQuery({
    queryKey: PRESETS_KEY,
    queryFn: () => api.get<BenchmarkPresetDto[]>('/api/benchmark-presets'),
    enabled,
    staleTime: 30_000,
  })
}

export function useCreateBenchmarkPreset() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: BenchmarkPresetBody) => api.post<BenchmarkPresetDto>('/api/benchmark-presets', body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PRESETS_KEY }),
  })
}

/** Whole replacement: renaming sends the preset back with its new name. */
export function useUpdateBenchmarkPreset() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: BenchmarkPresetBody }) => api.put<BenchmarkPresetDto>(`/api/benchmark-presets/${id}`, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PRESETS_KEY }),
  })
}

export function useDeleteBenchmarkPreset() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/benchmark-presets/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PRESETS_KEY }),
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

/** Sends one correction to finished runs, which reopen in their sessions; polling resumes with them. */
export function useFollowUpBenchmarkRuns(benchmarkId: string) {
  const patch = usePatchBenchmark()
  return useMutation({
    mutationFn: (body: FollowUpBenchmarkRunsBody) => api.post<BenchmarkDto>(`/api/benchmarks/${benchmarkId}/follow-ups`, body),
    onSuccess: patch,
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
 *
 * The shuffled order itself is stored, not a seed over the order of the day: a variant added to
 * the benchmark, or a lineup reordered, during a review would otherwise re-letter every card.
 * Variants added since the review started take the next letters; removed ones drop out.
 */
interface BlindState {
  order?: string[]
  /** Reviews started before the order was stored: a seed over the lineup's order then. */
  seed?: number
  revealed: boolean
}

const blindKey = (benchmarkId: string) => `sillage.benchmark.blind.${benchmarkId}`

function readBlind(benchmarkId: string): BlindState | null {
  try {
    const raw = localStorage.getItem(blindKey(benchmarkId))
    const parsed = raw ? (JSON.parse(raw) as BlindState) : null
    return parsed && (Array.isArray(parsed.order) || typeof parsed.seed === 'number') ? parsed : null
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

/** The review's order over today's lineup: stored ids that still exist, then the newcomers. */
function blindOrder(state: BlindState, variantIds: string[]): string[] {
  const stored = state.order ?? shuffled(variantIds, state.seed ?? 1)
  const known = stored.filter((id) => variantIds.includes(id))
  return [...known, ...variantIds.filter((id) => !known.includes(id))]
}

export function useBlindReview(benchmarkId: string, variantIds: string[]) {
  const [state, setState] = useState<BlindState | null>(() => readBlind(benchmarkId))
  const write = useCallback((next: BlindState | null) => {
    setState(next)
    try {
      if (next) localStorage.setItem(blindKey(benchmarkId), JSON.stringify(next))
      else localStorage.removeItem(blindKey(benchmarkId))
    } catch { /* private mode: the review lasts for the page */ }
  }, [benchmarkId])
  const order = useMemo(() => (state ? blindOrder(state, variantIds) : variantIds), [state, variantIds])
  // The order is written back whenever the lineup moved it: a seed is frozen the first time it is
  // read, removed variants leave it, newcomers join it once. Recomputed on every render instead,
  // newcomers would swap letters when the lineup is reordered, and an id given again to a new
  // variant would take the letter of the one it replaced.
  useEffect(() => {
    if (!state || variantIds.length === 0) return
    const stored = state.order
    if (!stored || stored.length !== order.length || stored.some((id, index) => id !== order[index])) write({ order, revealed: state.revealed })
  }, [state, order, variantIds.length, write])
  const active = state !== null && !state.revealed
  return {
    /** Variant names and settings are hidden. */
    active,
    /** A blind pass happened and was revealed: letters stay shown next to the names. */
    revealed: state?.revealed === true,
    /** Variant ids in display order while blind or revealed, original order otherwise. */
    order,
    letterOf: (variantId: string) => (state ? String.fromCharCode(65 + order.indexOf(variantId)) : null),
    start: () => write({ order: shuffled(variantIds, Math.floor(Math.random() * 2147483647) + 1), revealed: false }),
    reveal: () => state && write({ ...state, order, revealed: true }),
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

export const BENCHMARK_STATE_TONES: Record<BenchmarkState, 'neutral' | 'accent' | 'positive' | 'critical'> = {
  running: 'accent',
  done: 'positive',
  failed: 'critical',
  cancelled: 'neutral',
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

/** The colour of a run wherever it shows as a dot. */
export const RUN_TONES: Record<BenchmarkRunDto['status'], string> = {
  pending: 'bg-line-strong',
  running: 'bg-accent animate-pulse',
  checking: 'bg-accent animate-pulse',
  succeeded: 'bg-positive',
  failed: 'bg-critical',
  timed_out: 'bg-caution',
  cancelled: 'bg-line-strong',
}

/** Measurements shown as table columns, in reading order; the numbers come from the shared stats module. */
export type MetricKey = BenchmarkMetricKey
export const METRIC_KEYS: MetricKey[] = BENCHMARK_METRIC_KEYS

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

export const metricValue = benchmarkMetricValue

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

// The pure numbers live in the protocol, shared with the shared pages and the slides.
export { median, niceCeiling, passRate, spread } from '@sillage/protocol'

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
    'check_passed', 'check_exit_code', 'duration_ms', 'elapsed_ms', 'waiting_ms', 'first_text_ms', 'input_tokens', 'output_tokens',
    'cache_read_tokens', 'cache_creation_tokens', 'cost_usd', 'tool_calls', 'tool_errors', 'tool_duration_ms',
    'assistant_messages', 'output_chars', 'context_tokens', 'rating', 'rating_note', 'error', 'follow_ups', 'follow_up_texts',
  ]
  const cell = (value: number | string | boolean | null | undefined) => (value === null || value === undefined ? '' : String(value))
  const rows = benchmark.runs.map((run) => {
    const variant = benchmark.variants.find((entry) => entry.id === run.variantId)
    const m = run.metrics
    return [
      benchmark.name, variant?.label, variant ? variantAgent(variant) : '', variant?.config.model,
      variant ? variantEffort(variant.config) : '', m?.model, run.cliVersion, run.repetition, run.status,
      run.check ? run.check.passed : null, run.check?.exitCode, m?.durationMs, m?.elapsedMs, m?.waitingMs, m?.firstTextMs, m?.inputTokens,
      m?.outputTokens, m?.cacheReadTokens, m?.cacheCreationTokens, m?.costUsd, m?.toolCalls, m?.toolErrors,
      m?.toolDurationMs, m?.assistantMessages, m?.outputChars, m?.contextTokens, run.rating, run.ratingNote, run.error,
      // Appended rather than inserted: notebooks reading columns by position keep working.
      run.followUps.length, run.followUps.map((followUp) => followUp.text).join('\n---\n'),
    ].map(cell)
  })
  return { filename: `${exportStem(benchmark)}.csv`, content: toCsv([header, ...rows]) }
}

/** Everything the page knows, minus the preview capabilities: an export may travel. */
export function benchmarkJson(benchmark: BenchmarkDto): { filename: string; content: string } {
  const runs = benchmark.runs.map(({ previewToken: _token, ...run }) => run)
  return { filename: `${exportStem(benchmark)}.json`, content: JSON.stringify({ ...benchmark, runs }, null, 2) }
}

const shareKey = (benchmarkId: string) => ['benchmark-share', benchmarkId]

/**
 * What of a benchmark can leave Sillage: one verdict per run, and the public links already made.
 * Asked only while the share window is open: the verdict walks every run folder.
 */
export function useBenchmarkShare(benchmarkId: string, enabled: boolean) {
  return useQuery({
    queryKey: shareKey(benchmarkId),
    queryFn: () => api.get<BenchmarkShareStateDto>(`/api/benchmarks/${benchmarkId}/share`),
    enabled,
    staleTime: 0,
  })
}

export function usePublishBenchmarkShare(benchmarkId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: PublishBenchmarkShareBody) => api.post<BenchmarkShareDto>(`/api/benchmarks/${benchmarkId}/share`, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: shareKey(benchmarkId) }),
  })
}

export function useRevokeBenchmarkShare(benchmarkId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (shareId: string) => api.delete<void>(`/api/benchmarks/${benchmarkId}/share/${shareId}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: shareKey(benchmarkId) }),
  })
}

/** Regenerates a published link under the same address, with the options it was published with. */
export function useRefreshBenchmarkShare(benchmarkId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (shareId: string) => api.post<BenchmarkShareDto>(`/api/benchmarks/${benchmarkId}/share/${shareId}/refresh`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: shareKey(benchmarkId) }),
  })
}

/** What a share or a presentation starts from: everything shown, names visible, in the reader's language. */
export function defaultShareOptions(benchmark: Pick<BenchmarkDto, 'name'>, lang: string): BenchmarkShareOptions {
  return benchmarkShareOptionsSchema.parse({ title: benchmark.name, locale: lang.startsWith('fr') ? 'fr' : 'en' })
}

/** The same page as a public link, as a zip to send or host anywhere. A plain link: the browser downloads it. */
export function benchmarkArchiveUrl(benchmarkId: string, options: BenchmarkShareOptions): string {
  return `/api/benchmarks/${benchmarkId}/archive?options=${encodeURIComponent(JSON.stringify(options))}`
}

/** Median of one measure over a variant's eligible runs (succeeded, check passed), for summaries that name a winner. */
export function variantMedian(benchmark: BenchmarkDto, variantId: string, key: MetricKey): number | null {
  return median(eligibleRuns(benchmark, benchmark.runs.filter((run) => run.variantId === variantId)).map((run) => metricValue(run, key)))
}

/**
 * How the outputs of a benchmark are laid out, remembered per device: comparing is a matter of
 * screen size and taste, and the choice should survive moving from one benchmark to the next.
 */
export interface OutputsLayout {
  /** All variants at once, or one at a time to flip between. */
  mode: 'grid' | 'focus'
  /** Cards per row; 0 lets the width decide. */
  columns: 0 | 1 | 2 | 3 | 4
  height: 'compact' | 'medium' | 'tall'
  /** Width pages are rendered at; wider than the card, they are scaled down to fit. */
  viewport: 'fit' | 'desktop' | 'tablet' | 'phone'
  /** What every card shows unless one picked something else. */
  show: 'outputs' | 'responses'
}

const DEFAULT_OUTPUTS_LAYOUT: OutputsLayout = { mode: 'grid', columns: 0, height: 'medium', viewport: 'fit', show: 'outputs' }
const OUTPUTS_LAYOUT_KEY = 'sillage.benchmark.outputs'

export function useOutputsLayout(): [OutputsLayout, (change: Partial<OutputsLayout>) => void] {
  const [layout, setLayout] = useState<OutputsLayout>(() => {
    try {
      return { ...DEFAULT_OUTPUTS_LAYOUT, ...(JSON.parse(localStorage.getItem(OUTPUTS_LAYOUT_KEY) ?? '{}') as Partial<OutputsLayout>) }
    } catch {
      return DEFAULT_OUTPUTS_LAYOUT
    }
  })
  const update = useCallback((change: Partial<OutputsLayout>) => setLayout((current) => {
    const next = { ...current, ...change }
    try { localStorage.setItem(OUTPUTS_LAYOUT_KEY, JSON.stringify(next)) } catch { /* private mode: the choice lasts for the page */ }
    return next
  }), [])
  return [layout, update]
}

const shareOptionsKey = (benchmarkId: string) => `sillage.benchmark.share.${benchmarkId}`

/**
 * The share window's last options for a benchmark, on this device, over today's defaults: the
 * page header's Present button then opens the slides as they were last prepared there.
 */
export function readShareOptions(benchmark: Pick<BenchmarkDto, 'id' | 'name'>, lang: string): BenchmarkShareOptions {
  const defaults = defaultShareOptions(benchmark, lang)
  try {
    const raw = localStorage.getItem(shareOptionsKey(benchmark.id))
    const stored: unknown = raw ? JSON.parse(raw) : null
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return defaults
    // Field by field: the window writes on every keystroke, so a title left blank must not take
    // the blind switch, the reveal timing or the featured comparisons down with it.
    const options: Record<string, unknown> = { ...defaults }
    const shape = benchmarkShareOptionsSchema.shape
    for (const key of Object.keys(shape) as (keyof typeof shape)[]) {
      const field = shape[key].safeParse((stored as Record<string, unknown>)[key])
      if (field.success && (stored as Record<string, unknown>)[key] !== undefined) options[key] = field.data
    }
    const parsed = benchmarkShareOptionsSchema.safeParse(options)
    return parsed.success ? parsed.data : defaults
  } catch {
    return defaults
  }
}

export function writeShareOptions(benchmarkId: string, options: BenchmarkShareOptions): void {
  try { localStorage.setItem(shareOptionsKey(benchmarkId), JSON.stringify(options)) } catch { /* private mode: the choice lasts for the window */ }
}

/**
 * Opens the live slides in a window of their own, sized for a 1080p capture: nothing of the app
 * (its update prompt, its sidebar) can then appear in a recording. Reusing the window's name
 * brings an open slideshow back instead of stacking a second one.
 */
export function openSlides(benchmarkId: string, options: BenchmarkShareOptions): void {
  window.open(benchmarkLiveUrl(benchmarkId, 'slides', options), `sillage-slides-${benchmarkId}`, 'popup,width=1920,height=1080')
}

/** The shared page as it would be published, rendered live over the run folders. */
export function openPagePreview(benchmarkId: string, options: BenchmarkShareOptions): void {
  window.open(benchmarkLiveUrl(benchmarkId, 'page', options), `sillage-page-${benchmarkId}`)
}
