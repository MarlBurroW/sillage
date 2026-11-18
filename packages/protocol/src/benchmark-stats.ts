import type { BenchmarkDto, BenchmarkRunDto } from './benchmarks.js'

/**
 * The numbers every benchmark surface derives from runs: the app's table, chart and comparison,
 * the shared page and the slides. One computation, so a winner named on a video is the winner
 * the app names; each surface keeps its own presentation.
 */

/** Measures read per run, in reading order. */
export type BenchmarkMetricKey =
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

export const BENCHMARK_METRIC_KEYS: BenchmarkMetricKey[] = [
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

/**
 * Which way is better, for measures where it is not a matter of taste. Tokens, tool calls and
 * message counts have none: more tool calls can mean a more careful agent, and cost already
 * prices the tokens. A measure without a direction shows differences but never names a winner.
 */
export type BenchmarkMetricDirection = 'lower' | 'higher' | null

export const BENCHMARK_METRIC_DIRECTIONS: Record<BenchmarkMetricKey, BenchmarkMetricDirection> = {
  rating: 'higher',
  durationMs: 'lower',
  waitingMs: null,
  firstTextMs: 'lower',
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  costUsd: 'lower',
  toolCalls: null,
  toolErrors: 'lower',
  toolDurationMs: null,
  assistantMessages: null,
  outputChars: null,
  contextTokens: null,
}

export function benchmarkMetricValue(run: BenchmarkRunDto, key: BenchmarkMetricKey): number | null {
  if (key === 'rating') return run.rating
  if (!run.metrics) return null
  // Measurements folded before a field existed read as unreported rather than undefined.
  return run.metrics[key] ?? null
}

/** Tokens read and written, cache included; null when the CLI reported neither. */
export function runTotalTokens(run: BenchmarkRunDto): number | null {
  const metrics = run.metrics
  if (!metrics || (metrics.inputTokens === null && metrics.outputTokens === null)) return null
  return (metrics.inputTokens ?? 0) + (metrics.outputTokens ?? 0)
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

/** 1, 2, 2.5 or 5 times a power of ten: axis ends a reader can say aloud. */
export function niceCeiling(value: number): number {
  if (value <= 0) return 0
  const power = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * power >= value) ?? 10
  return step * power
}

/** Runs whose script ran, and how many passed. Null when the benchmark has no script. */
export function passRate(benchmark: Pick<BenchmarkDto, 'checkScript'>, runs: BenchmarkRunDto[]): { passed: number; checked: number } | null {
  if (!benchmark.checkScript) return null
  const checked = runs.filter((run) => run.check !== null)
  return { passed: checked.filter((run) => run.check?.passed).length, checked: checked.length }
}

/**
 * Runs that count when naming a winner: settled successfully and, when the benchmark has a
 * script, passed it. A run that crashed after thirty seconds is neither the fastest nor the
 * cheapest.
 */
export function eligibleRuns(benchmark: Pick<BenchmarkDto, 'checkScript'>, runs: BenchmarkRunDto[]): BenchmarkRunDto[] {
  return runs.filter((run) => run.status === 'succeeded' && (!benchmark.checkScript || run.check?.passed === true))
}

/** Pseudo-measure of comparisons: the share of runs that passed the check script. */
export type BenchmarkComparedKey = BenchmarkMetricKey | 'passRate'

export interface VariantMeasure {
  variantId: string
  /** Median over eligible runs, or over every run when none is eligible. */
  median: number | null
  min: number | null
  max: number | null
  /** Runs the median was taken over. */
  count: number
  /** Whether those runs may win: false when the median comes from failed runs only. */
  eligible: boolean
}

function runsOf(benchmark: Pick<BenchmarkDto, 'runs'>, variantId: string): BenchmarkRunDto[] {
  return benchmark.runs.filter((run) => run.variantId === variantId)
}

export function variantMeasure(benchmark: Pick<BenchmarkDto, 'runs' | 'checkScript'>, variantId: string, key: BenchmarkComparedKey): VariantMeasure {
  const runs = runsOf(benchmark, variantId)
  if (key === 'passRate') {
    const rate = passRate(benchmark, runs)
    const value = rate && rate.checked > 0 ? rate.passed / rate.checked : null
    return { variantId, median: value, min: value, max: value, count: rate?.checked ?? 0, eligible: value !== null }
  }
  const eligible = eligibleRuns(benchmark, runs)
  const pool = eligible.length > 0 ? eligible : runs
  const values = pool.map((run) => benchmarkMetricValue(run, key)).filter((value): value is number => value !== null)
  return {
    variantId,
    median: median(values),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    count: values.length,
    eligible: eligible.length > 0 && values.length > 0,
  }
}

export function comparedDirection(key: BenchmarkComparedKey): BenchmarkMetricDirection {
  return key === 'passRate' ? 'higher' : BENCHMARK_METRIC_DIRECTIONS[key]
}

/**
 * Measures a comparison's verdict counts, the same on every surface: those whose better side
 * nobody disputes. Time to first text and tool errors still show a winner on their own row, but
 * a tally that counted them would let side measures outvote time and cost. Ratings count only
 * where they are shown.
 */
export const COMPARISON_VERDICT_KEYS: BenchmarkComparedKey[] = ['durationMs', 'costUsd', 'passRate', 'rating']

/** Measures won by each variant over the verdict measures, ties counting for nobody. */
export function verdictTally(rows: ComparisonRow[], includeRating: boolean): Map<string, number> {
  const tally = new Map<string, number>()
  for (const row of rows) {
    if (!COMPARISON_VERDICT_KEYS.includes(row.key) || (row.key === 'rating' && !includeRating) || !row.winner) continue
    tally.set(row.winner, (tally.get(row.winner) ?? 0) + 1)
  }
  return tally
}

export interface ComparisonRow {
  key: BenchmarkComparedKey
  direction: BenchmarkMetricDirection
  /** One per compared variant, in the order asked. */
  measures: VariantMeasure[]
  /** Best eligible median; null without a direction or fewer than two eligible values. */
  best: number | null
  /** The single variant holding the best value; null on a tie or without a winner. */
  winner: string | null
}

/**
 * Measure by measure, which of the given variants does best. Only eligible values compete, a null
 * never wins, and equal medians tie: no overall score, since any weighting would be arbitrary.
 */
export function compareVariants(
  benchmark: Pick<BenchmarkDto, 'runs' | 'checkScript'>,
  variantIds: string[],
  keys: BenchmarkComparedKey[],
): ComparisonRow[] {
  return keys.map((key) => {
    const direction = comparedDirection(key)
    const measures = variantIds.map((id) => variantMeasure(benchmark, id, key))
    const competing = measures.filter((measure) => measure.eligible && measure.median !== null)
    if (!direction || competing.length < 2) return { key, direction, measures, best: null, winner: null }
    const values = competing.map((measure) => measure.median!)
    const best = direction === 'lower' ? Math.min(...values) : Math.max(...values)
    const holders = competing.filter((measure) => measure.median === best)
    return { key, direction, measures, best, winner: holders.length === 1 ? holders[0]!.variantId : null }
  })
}

/**
 * How far a value stands from the best one: a factor for amounts ("2.3 times slower") and a
 * difference for scales whose zero means nothing (ratings, pass rates). Null when either side is
 * missing or the factor would divide by zero.
 */
export function distanceFromBest(key: BenchmarkComparedKey, value: number | null, best: number | null): { factor: number | null; difference: number | null } | null {
  if (value === null || best === null) return null
  if (key === 'rating' || key === 'passRate') return { factor: null, difference: value - best }
  if (best === 0 || value === 0) return { factor: null, difference: value - best }
  return { factor: Math.max(value, best) / Math.min(value, best), difference: value - best }
}

/** Rank of each value, 1 for the best, ties sharing a rank; an unknown value has no rank. */
export function rankValues(values: (number | null)[], direction: 'lower' | 'higher'): (number | null)[] {
  const known = values.filter((value): value is number => value !== null)
  const better = (other: number, value: number) => (direction === 'lower' ? other < value : other > value)
  return values.map((value) => (value === null ? null : 1 + known.filter((other) => better(other, value)).length))
}
