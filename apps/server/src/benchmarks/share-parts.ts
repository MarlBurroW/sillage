import MarkdownIt from 'markdown-it'
import {
  benchmarkMetricValue,
  comparedDirection,
  eligibleRuns,
  median,
  passRate,
  runTotalTokens,
  type BenchmarkComparison,
  type BenchmarkDto,
  type BenchmarkMetricDirection,
  type BenchmarkRunDto,
  type BenchmarkShareOptions,
} from '@sillage/protocol'

/**
 * Pieces shared by the documents a benchmark leaves Sillage as: the shared page and the
 * slideshow. Both are self-contained HTML written on the server; they differ in layout, not in
 * how numbers read or how an agent's message is made safe.
 */

/**
 * Measures a shared document shows. Tokens are read and written together, as the page always
 * showed them; `passRate` is the share of runs that passed the check script.
 */
export type ShareMeasureKey = 'durationMs' | 'tokens' | 'costUsd' | 'toolCalls' | 'passRate' | 'rating'

export interface ShareMeasureValue {
  /** Median over eligible runs, or over every run when none is eligible. */
  median: number | null
  /** The values the median was taken over, for one dot per run. */
  values: number[]
  /** False when the value comes from failed runs only: it is shown but never wins. */
  eligible: boolean
  /** For `passRate`: passed and checked runs. */
  passed: number
  checked: number
}

export interface ShareMeasure {
  key: ShareMeasureKey
  direction: BenchmarkMetricDirection
  /** One per shown variant, in display order. */
  values: ShareMeasureValue[]
  /** Position of the single best eligible variant; null on a tie, without a direction or a rival. */
  best: number | null
}

/**
 * The numbers of a shared document, on the same rules as the app's comparison: winners only among
 * runs that succeeded (and passed the script), a null never wins, equal medians tie, and measures
 * without a better direction (tokens, tool calls) never name one. `runs` must be the shared copies,
 * whose ratings are already removed when the publication leaves them out.
 */
export function shareMeasures(
  benchmark: Pick<BenchmarkDto, 'checkScript'>,
  order: string[],
  runs: BenchmarkRunDto[],
  includeRatings: boolean,
): ShareMeasure[] {
  const keys: ShareMeasureKey[] = ['durationMs', 'tokens', 'costUsd', 'toolCalls']
  if (benchmark.checkScript) keys.push('passRate')
  if (includeRatings) keys.push('rating')
  const measures = keys.map((key): ShareMeasure => {
    const values = order.map((variantId): ShareMeasureValue => {
      const own = runs.filter((run) => run.variantId === variantId)
      if (key === 'passRate') {
        const rate = passRate(benchmark, own)
        const value = rate && rate.checked > 0 ? rate.passed / rate.checked : null
        return { median: value, values: value === null ? [] : [value], eligible: value !== null, passed: rate?.passed ?? 0, checked: rate?.checked ?? 0 }
      }
      const eligible = eligibleRuns(benchmark, own)
      const pool = eligible.length > 0 ? eligible : own
      const read = (run: BenchmarkRunDto) => (key === 'tokens' ? runTotalTokens(run) : benchmarkMetricValue(run, key))
      const known = pool.map(read).filter((value): value is number => value !== null)
      return { median: median(known), values: known, eligible: eligible.length > 0 && known.length > 0, passed: 0, checked: 0 }
    })
    const direction = key === 'tokens' ? null : comparedDirection(key)
    return { key, direction, values, best: bestPosition(values, direction) }
  })
  return measures.filter((measure) => measure.values.some((value) => value.median !== null))
}

function bestPosition(values: ShareMeasureValue[], direction: BenchmarkMetricDirection): number | null {
  if (!direction) return null
  const competing = values.map((value, index) => ({ value, index })).filter(({ value }) => value.eligible && value.median !== null)
  if (competing.length < 2) return null
  const best = direction === 'lower' ? Math.min(...competing.map(({ value }) => value.median!)) : Math.max(...competing.map(({ value }) => value.median!))
  const holders = competing.filter(({ value }) => value.median === best)
  return holders.length === 1 ? holders[0]!.index : null
}

/**
 * Saved comparisons a publication features: the ones its options name (all of them when it names
 * none), kept only when every contestant is shown.
 */
export function featuredComparisons(benchmark: Pick<BenchmarkDto, 'comparisons'>, options: Pick<BenchmarkShareOptions, 'comparisons'>, shown: string[]): BenchmarkComparison[] {
  const chosen = options.comparisons === null ? benchmark.comparisons ?? [] : (benchmark.comparisons ?? []).filter((comparison) => options.comparisons!.includes(comparison.id))
  return chosen.filter((comparison) => comparison.variantIds.every((id) => shown.includes(id)))
}

/** Attribute given to every embedded production: scripts run, in an origin that owns nothing. */
export const FRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock'

/** Fills `{name}` placeholders of a catalog string. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
}

export const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

/** A, B, … Z, then A1, B1: letters name variants on blind pages and in slides. */
export function letterOf(index: number): string {
  return String.fromCharCode(65 + (index % 26)) + (index >= 26 ? String(Math.floor(index / 26)) : '')
}

/** Human formatting of the measures, in the page's language. */
export function formatters(locale: 'en' | 'fr') {
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
  const plain = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  return {
    duration(ms: number): string {
      if (ms < 1000) return `${Math.round(ms)} ms`
      const seconds = ms / 1000
      if (seconds < 10) return `${plain.format(seconds)} s`
      if (seconds < 60) return `${Math.round(seconds)} s`
      const minutes = Math.floor(seconds / 60)
      const rest = Math.round(seconds - minutes * 60)
      if (minutes < 60) return rest ? `${minutes} min ${String(rest).padStart(2, '0')} s` : `${minutes} min`
      return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
    },
    tokens: (count: number) => compact.format(count),
    cost: (usd: number) =>
      new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: usd < 0.1 ? 3 : 2 }).format(usd),
    number: (value: number) => plain.format(value),
    date: (ts: number) => new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(ts),
  }
}

/**
 * Markdown for an agent's final message. An agent's message may point at local images or paths:
 * only real web links stay clickable, and raw HTML is never rendered.
 */
export function messageRenderer(): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
  md.linkify.set({ fuzzyLink: false })
  md.renderer.rules.image = () => ''
  md.renderer.rules.link_open = (tokens, index, opts, _env, self) => {
    if (!/^https?:\/\//i.test(tokens[index]!.attrGet('href') ?? '')) return '<span>'
    tokens[index]!.attrSet('target', '_blank')
    tokens[index]!.attrSet('rel', 'noopener noreferrer')
    return self.renderToken(tokens, index, opts)
  }
  md.renderer.rules.link_close = (tokens, index) => {
    for (let i = index - 1; i >= 0; i--) {
      if (tokens[i]!.type === 'link_open') return /^https?:\/\//i.test(tokens[i]!.attrGet('href') ?? '') ? '</a>' : '</span>'
    }
    return '</span>'
  }
  md.renderer.rules.table_open = () => '<div class="table-wrap"><table>'
  md.renderer.rules.table_close = () => '</table></div>'
  return md
}

/**
 * JSON inside a `<script type="application/json">` block: not executed, so the page's policy does
 * not apply to it, but `<` would let user text close the element, and U+2028/U+2029 break older
 * parsers. The reading script builds the DOM from it with `textContent` only.
 */
export function jsonBlock(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}
