import { ArrowLeftRight, Crown, Trophy, X } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  COMPARISON_VERDICT_KEYS,
  compareVariants,
  passRate,
  variantAgent,
  verdictTally,
  type BenchmarkComparedKey,
  type BenchmarkDto,
  type BenchmarkVariantDto,
  type ComparisonRow,
  type VariantMeasure,
} from '@sillage/protocol'
import { formatListPrice } from '../../lib/benchmark-lineup'
import { METRIC_LABELS, formatMetric, isOpenRun, type MetricKey } from '../../lib/benchmarks'
import { locale, useTranslate, type MessageKey } from '../../lib/i18n'
import { AgentIcon } from '../AgentIcon'
import { Banner, Button, IconButton, cx } from '../ui'
import { OutputsViewer } from './OutputsViewer'

/**
 * Measures a comparison reads, in this order: those that name a winner first (time, cost,
 * rating, checks), then the amounts that only describe how a variant worked.
 */
const COMPARED: BenchmarkComparedKey[] = [
  'durationMs', 'costUsd', 'rating', 'passRate', 'firstTextMs', 'toolErrors',
  'outputTokens', 'inputTokens', 'toolCalls', 'toolDurationMs', 'assistantMessages', 'outputChars',
]

/** Measures worth a verdict tile: the questions a reader asks first. */
const VERDICTS: BenchmarkComparedKey[] = ['durationMs', 'costUsd', 'rating', 'passRate']

const MARGIN_LABELS: Partial<Record<BenchmarkComparedKey, MessageKey>> = {
  durationMs: 'benchmark.compare.margin.faster',
  firstTextMs: 'benchmark.compare.margin.sooner',
  costUsd: 'benchmark.compare.margin.cheaper',
}

const DAY = 24 * 60 * 60 * 1000

/**
 * Two to four variants measure by measure. Two make a duel: who wins what, by how much, bars
 * facing each other. More make a matrix against the first one picked, the baseline. Winners come
 * from the shared rules: only runs that succeeded (and passed the check) compete, a missing value
 * never wins, equal medians tie, and measures without a better direction name no winner.
 */
export default function ComparisonView({
  benchmark,
  ids,
  nameOf,
  metricKeys,
  onBaseline,
  onRemove,
  onRunSettings,
}: {
  benchmark: BenchmarkDto
  /** Compared variant ids, the baseline first; two to four. */
  ids: string[]
  nameOf: (variantId: string) => { label: ReactNode; text: string }
  /** Measures this benchmark shows: a comparison never brings back a hidden column. */
  metricKeys: MetricKey[]
  onBaseline: (variantId: string) => void
  /** Absent when the benchmark has only these variants: there is nothing to take out. */
  onRemove?: (variantId: string) => void
  /** Opens the run settings, where more runs per variant can be queued. */
  onRunSettings: () => void
}) {
  const t = useTranslate()
  const lang = locale()
  const variants = ids.flatMap((id) => benchmark.variants.find((variant) => variant.id === id) ?? [])
  const keys = COMPARED.filter((key) => (key === 'passRate' ? !!benchmark.checkScript : metricKeys.includes(key)))
  const rows = compareVariants(benchmark, variants.map((variant) => variant.id), keys)
    .filter((row) => row.measures.some((measure) => measure.median !== null))
  const verdicts = rows.filter((row) => VERDICTS.includes(row.key) && row.direction)
  // The tally counts the verdict measures only, as the shared page and the slides do: a sooner
  // first text or fewer tool errors still win their own row, but must not outvote time and cost.
  const rated = keys.includes('rating')
  const wins = verdictTally(rows, rated)
  // Trophies mark what the tally counts, so a column's trophies always add up to its "N wins".
  const counts = (row: ComparisonRow) => COMPARISON_VERDICT_KEYS.includes(row.key) && (row.key !== 'rating' || rated)

  // Medians resting on a single usable run each, and no more on the way: a gap can then be chance,
  // whether one run was asked for or failures left one. The pass rate counts every checked run,
  // failed ones included, so it says nothing about how many runs a median stands on.
  const used = (variantId: string) => Math.max(0, ...rows.filter((row) => row.key !== 'passRate')
    .map((row) => row.measures.find((measure) => measure.variantId === variantId)?.count ?? 0))
  const pending = benchmark.runs.some((run) => ids.includes(run.variantId) && isOpenRun(run))
  const singleRuns = rows.length > 0 && !pending && variants.every((variant) => used(variant.id) <= 1)
  const starts = variants.map((variant) => Math.min(...benchmark.runs.filter((run) => run.variantId === variant.id && run.startedAt !== null).map((run) => run.startedAt!)))
  const known = starts.filter(Number.isFinite)
  const apart = known.length > 1 && Math.max(...known) - Math.min(...known) > DAY

  const label = (key: BenchmarkComparedKey) => t(key === 'passRate' ? 'benchmark.compare.passRate' : METRIC_LABELS[key])
  const value = (key: BenchmarkComparedKey, measure: VariantMeasure): string => {
    if (key === 'passRate') {
      const rate = passRate(benchmark, benchmark.runs.filter((run) => run.variantId === measure.variantId))
      return rate && rate.checked > 0 ? `${rate.passed}/${rate.checked}` : '—'
    }
    return formatMetric(key, measure.median, lang)
  }

  /** A contestant's heading; mirrored on the duel's right side so actions sit beside each name. */
  const header = (variant: BenchmarkVariantDto, index: number, mirrored = false) => (
    <div className={cx('flex min-w-0 flex-col gap-1', mirrored && 'items-end text-right')} data-compare-head={variant.id}>
      <div className={cx('flex min-w-0 max-w-full items-center gap-2', mirrored && 'flex-row-reverse')}>
        <AgentIcon agent={variantAgent(variant)} size={16} />
        <span className="min-w-0 truncate font-medium">{nameOf(variant.id).label}</span>
        {index === 0 && variants.length > 2 ? <span className="shrink-0 rounded border border-line px-1.5 text-[0.6875rem] text-ink-faint">{t('benchmark.compare.baseline')}</span> : null}
        <span className={cx('flex shrink-0 items-center', mirrored && 'flex-row-reverse')}>
          {variants.length === 2 && index === 0 ? (
            <IconButton size="sm" label={t('benchmark.compare.swap')} onClick={() => onBaseline(variants[1]!.id)}><ArrowLeftRight size={14} /></IconButton>
          ) : null}
          {variants.length > 2 && index > 0 ? (
            <IconButton size="sm" label={t('benchmark.compare.makeBaseline')} onClick={() => onBaseline(variant.id)}><Crown size={14} /></IconButton>
          ) : null}
          {onRemove ? (
            <IconButton size="sm" label={t('benchmark.compare.remove', { name: nameOf(variant.id).text })} onClick={() => onRemove(variant.id)}><X size={14} /></IconButton>
          ) : null}
        </span>
      </div>
      <p className="max-w-full truncate text-xs text-ink-faint">
        {[
          variant.technicalLabel !== variant.label ? variant.technicalLabel : null,
          cliVersion(benchmark, variant.id) ? `v${cliVersion(benchmark, variant.id)}` : null,
          variant.listPrice ? t('benchmark.compare.listPricePair', { price: formatListPrice(variant.listPrice, lang) }) : null,
          apart && Number.isFinite(starts[index]) ? t('benchmark.compare.ranOn', { date: new Date(starts[index]!).toLocaleDateString(lang, { dateStyle: 'medium' }) }) : null,
        ].filter(Boolean).join(' · ')}
      </p>
      {wins.get(variant.id) ? (
        <span className="inline-flex items-center gap-1 text-xs text-accent"><Trophy size={12} aria-hidden />{t(wins.get(variant.id) === 1 ? 'benchmark.compare.wins.one' : 'benchmark.compare.wins', { count: wins.get(variant.id)! })}</span>
      ) : null}
    </div>
  )

  return (
    <section className="flex flex-col gap-5" data-benchmark-compare={variants.length === 2 ? 'duel' : 'matrix'}>
      {singleRuns ? (
        <Banner tone="info">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{t('benchmark.compare.singleRun')}</span>
            <Button size="sm" variant="ghost" onClick={onRunSettings}>{t('benchmark.settings.edit')}</Button>
          </span>
        </Banner>
      ) : null}

      {verdicts.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-compare-verdicts>
          {verdicts.map((row) => <Verdict key={row.key} row={row} label={label(row.key)} benchmark={benchmark} nameOf={nameOf} lang={lang} />)}
        </div>
      ) : null}

      {variants.length === 2 ? (
        <div className="flex flex-col rounded-lg border border-line" data-compare-duel>
          <div className="grid grid-cols-2 gap-4 border-b border-line px-4 py-3">
            {header(variants[0]!, 0)}
            {header(variants[1]!, 1, true)}
          </div>
          <ul className="flex flex-col divide-y divide-line/60">
            {rows.map((row) => <DuelRow key={row.key} row={row} label={label(row.key)} trophy={counts(row)} format={(measure) => value(row.key, measure)} />)}
          </ul>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line" data-compare-matrix>
          <table className="w-full min-w-max border-collapse text-sm">
            <thead>
              <tr className="bg-surface-high text-left align-top">
                <th scope="col" className="sticky left-0 z-10 bg-surface-high px-3 py-2 text-xs font-medium text-ink-faint">{t('benchmark.compare.measure')}</th>
                {variants.map((variant, index) => <th key={variant.id} scope="col" className="min-w-48 px-3 py-2 font-normal">{header(variant, index)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-line/60 align-top" data-compare-row={row.key}>
                  <th scope="row" className="sticky left-0 bg-surface px-3 py-2 text-left text-xs font-medium whitespace-nowrap text-ink-soft">{label(row.key)}</th>
                  {row.measures.map((measure, index) => {
                    const won = row.winner === measure.variantId
                    const delta = index === 0 ? null : relative(row.key, measure.median, row.measures[0]!.median, lang)
                    return (
                      <td key={measure.variantId} className={cx('px-3 py-2 tabular-nums', won && 'bg-accent-wash/60')} data-compare-cell={measure.variantId} data-compare-winner={won || undefined}>
                        <span className={cx('inline-flex items-center gap-1 font-medium', won && 'text-accent')}>
                          {won ? <BestMark trophy={counts(row)} /> : null}
                          {value(row.key, measure)}
                        </span>
                        {measure.count > 1 && measure.min !== null && measure.max !== null && row.key !== 'passRate' ? (
                          <span className="block text-[0.6875rem] text-ink-faint">{formatMetric(row.key, measure.min, lang)} – {formatMetric(row.key, measure.max, lang)}</span>
                        ) : null}
                        {delta ? <span className="block text-xs text-ink-faint">{delta}</span> : null}
                        {!measure.eligible && measure.median !== null && row.key !== 'passRate' ? <span className="block text-[0.6875rem] text-caution">{t('benchmark.compare.failedOnly')}</span> : null}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-ink-faint">
        {variants.length > 2 ? `${t('benchmark.compare.matrixLegend')} ` : null}{t('benchmark.compare.legend')} {t('benchmark.compare.trophyLegend')}
      </p>

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">{t('benchmark.tab.outputs')}</h2>
        <OutputsViewer benchmark={benchmark} order={variants.map((variant) => variant.id)} nameOf={nameOf} blind={false} />
      </div>
    </section>
  )
}

/** One question with its answer: who wins this measure, and by how much over the runner-up. */
function Verdict({ row, label, benchmark, nameOf, lang }: {
  row: ComparisonRow
  label: string
  benchmark: BenchmarkDto
  nameOf: (variantId: string) => { label: ReactNode; text: string }
  lang: string
}) {
  const t = useTranslate()
  const competing = row.measures.filter((measure) => measure.eligible && measure.median !== null)
  const winner = row.winner ? benchmark.variants.find((variant) => variant.id === row.winner) : null
  let answer: ReactNode
  let margin: string | null = null
  if (winner && row.best !== null) {
    const runnerUp = competing.filter((measure) => measure.variantId !== row.winner)
      .sort((a, b) => (row.direction === 'lower' ? a.median! - b.median! : b.median! - a.median!))[0]
    margin = runnerUp ? marginText(t, row, row.best, runnerUp, benchmark, lang) : null
    answer = (
      <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-accent">
        <Trophy size={14} aria-hidden className="shrink-0" />
        <AgentIcon agent={variantAgent(winner)} size={14} />
        <span className="truncate">{nameOf(winner.id).label}</span>
      </span>
    )
  } else {
    answer = <span className="font-medium text-ink-soft">{t(competing.length >= 2 ? 'benchmark.compare.tie' : 'benchmark.compare.noWinner')}</span>
  }
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-line px-3 py-2.5" data-compare-verdict={row.key} data-winner={row.winner ?? ''}>
      <span className="text-xs text-ink-faint">{label}</span>
      {answer}
      {margin ? <span className="text-xs text-ink-soft">{margin}</span> : null}
      {!winner && competing.length < 2 ? <span className="text-xs text-ink-faint">{t('benchmark.compare.noWinnerHint')}</span> : null}
    </div>
  )
}

/** "2.3× cheaper", "18 % faster", "+1 point": the winner's lead over the runner-up, in the reader's words. */
function marginText(
  t: ReturnType<typeof useTranslate>,
  row: ComparisonRow,
  best: number,
  runnerUp: VariantMeasure,
  benchmark: BenchmarkDto,
  lang: string,
): string | null {
  const other = runnerUp.median
  if (other === null) return null
  if (row.key === 'rating') {
    return t('benchmark.compare.margin.rating', { amount: (best - other).toLocaleString(lang, { maximumFractionDigits: 1 }) })
  }
  if (row.key === 'passRate') {
    const rate = (variantId: string) => passRate(benchmark, benchmark.runs.filter((run) => run.variantId === variantId))
    const winner = rate(row.winner!)
    const loser = rate(runnerUp.variantId)
    return winner && loser ? t('benchmark.compare.margin.passRate', { winner: `${winner.passed}/${winner.checked}`, other: `${loser.passed}/${loser.checked}` }) : null
  }
  const key = MARGIN_LABELS[row.key]
  if (!key) {
    return row.key === 'toolErrors' ? t(other - best === 1 ? 'benchmark.compare.margin.fewerErrors.one' : 'benchmark.compare.margin.fewerErrors', { count: other - best }) : null
  }
  if (best <= 0 || other <= 0) return null
  return t(key, { amount: lead(other, best, lang) })
}

/** The lead of a smaller amount over a larger one: a factor from twice, a share of the larger below. */
function lead(larger: number, smaller: number, lang: string): string {
  const factor = larger / smaller
  if (factor >= 2) return `${factor.toLocaleString(lang, { maximumFractionDigits: 1 })}×`
  return `${Math.round(((larger - smaller) / larger) * 100).toLocaleString(lang)} %`
}

/**
 * A value against the baseline: a signed share while they stay within a factor of two, a factor
 * beyond, a difference for scales whose zero means nothing.
 */
function relative(key: BenchmarkComparedKey, value: number | null, baseline: number | null, lang: string): string | null {
  if (value === null || baseline === null) return null
  if (key === 'rating' || key === 'passRate') {
    const difference = key === 'passRate' ? Math.round((value - baseline) * 100) : value - baseline
    if (difference === 0) return '='
    const text = Math.abs(difference).toLocaleString(lang, { maximumFractionDigits: 1 })
    return `${difference > 0 ? '+' : '−'}${text}${key === 'passRate' ? ' pts' : ''}`
  }
  if (baseline === 0 || value === 0) return value === baseline ? '=' : null
  const ratio = value / baseline
  if (ratio === 1) return '='
  if (ratio >= 2 || ratio <= 0.5) return `×${ratio.toLocaleString(lang, { maximumFractionDigits: ratio < 1 ? 2 : 1 })}`
  return `${ratio > 1 ? '+' : '−'}${Math.round(Math.abs(ratio - 1) * 100).toLocaleString(lang)} %`
}

/**
 * The winner's mark on one measure: a trophy where the measure counts in the tally, otherwise the
 * accent alone, with the word for screen readers either way.
 */
function BestMark({ trophy }: { trophy: boolean }) {
  const t = useTranslate()
  return trophy
    ? <Trophy size={12} aria-label={t('benchmark.compare.best')} />
    : <span className="sr-only">{t('benchmark.compare.best')}</span>
}

/** One measure of a duel: bars growing outwards from the middle, each row on its own scale. */
function DuelRow({ row, label, trophy, format }: {
  row: ComparisonRow
  label: string
  /** The measure counts in the tally: its winner gets a trophy. */
  trophy: boolean
  format: (measure: VariantMeasure) => string
}) {
  const t = useTranslate()
  const lang = locale()
  const [left, right] = row.measures as [VariantMeasure, VariantMeasure]
  const max = Math.max(left.median ?? 0, right.median ?? 0)
  const width = (measure: VariantMeasure) => (max > 0 && measure.median !== null ? Math.max(2, (measure.median / max) * 100) : 0)
  const factor = left.median !== null && right.median !== null && left.median > 0 && right.median > 0 && row.key !== 'rating' && row.key !== 'passRate'
    ? Math.max(left.median, right.median) / Math.min(left.median, right.median)
    : null
  const side = (measure: VariantMeasure, align: 'left' | 'right') => {
    const won = row.winner === measure.variantId
    // Said under the value it concerns, as the matrix does: in the middle it named neither side.
    const failedOnly = !measure.eligible && measure.median !== null && row.key !== 'passRate'
    return (
      <div className={cx('flex min-w-0 items-center gap-2', align === 'left' ? 'flex-row' : 'flex-row-reverse')} data-duel-side={measure.variantId} data-winner={won || undefined}>
        <span className={cx('flex shrink-0 flex-col leading-tight', align === 'left' ? 'items-start' : 'items-end')}>
          <span className={cx('inline-flex items-center gap-1 text-sm tabular-nums', won ? 'font-semibold text-accent' : 'text-ink-soft')}>
            {won ? <BestMark trophy={trophy} /> : null}
            {format(measure)}
          </span>
          {failedOnly ? <span className="text-[0.6875rem] text-caution" data-duel-failed-only>{t('benchmark.compare.failedOnly')}</span> : null}
        </span>
        <div className={cx('flex h-2.5 min-w-0 flex-1', align === 'left' ? 'justify-end' : 'justify-start')}>
          <span
            aria-hidden
            className={cx('h-full', align === 'left' ? 'rounded-l' : 'rounded-r', won ? 'bg-accent' : row.direction ? 'bg-line-strong' : 'bg-ink-faint/50')}
            style={{ width: `${width(measure)}%` }}
          />
        </div>
      </div>
    )
  }
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_minmax(6.5rem,auto)_minmax(0,1fr)] items-center gap-3 px-4 py-2.5" data-duel-row={row.key}>
      {side(left, 'left')}
      <div className="flex flex-col items-center text-center leading-tight">
        <span className="text-xs font-medium text-ink-soft">{label}</span>
        <span className="text-[0.6875rem] text-ink-faint tabular-nums">
          {factor !== null && factor !== 1 ? `×${factor.toLocaleString(lang, { maximumFractionDigits: 1 })}` : row.winner === null && row.direction && row.best !== null ? t('benchmark.compare.tie') : '\u00a0'}
        </span>
      </div>
      {side(right, 'right')}
    </li>
  )
}

function cliVersion(benchmark: BenchmarkDto, variantId: string): string | null {
  return benchmark.runs.filter((run) => run.variantId === variantId).map((run) => run.cliVersion).find((version) => version !== null) ?? null
}
