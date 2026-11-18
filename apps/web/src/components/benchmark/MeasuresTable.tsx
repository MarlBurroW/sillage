import { ArrowDown, ArrowUp, Check, ExternalLink, X } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  BENCHMARK_METRIC_DIRECTIONS,
  MAX_BENCHMARK_COMPARISON_VARIANTS,
  conversationPath,
  eligibleRuns,
  passRate,
  variantAgent,
  variantMeasure,
  type BenchmarkDto,
  type BenchmarkRunDto,
  type BenchmarkVariantDto,
} from '@sillage/protocol'
import { modelsAccount } from '../../lib/agents'
import { METRIC_KEYS, METRIC_LABELS, RUN_STATUS_LABELS, RUN_TONES, formatMetric, metricValue, type MetricKey } from '../../lib/benchmarks'
import { useLiveStatus } from '../../lib/conversation-status'
import { locale, useTranslate, type MessageKey } from '../../lib/i18n'
import { AGENT_LABELS, AgentIcon } from '../AgentIcon'
import { Badge, cx } from '../ui'

export interface Sort {
  key: MetricKey
  direction: 'asc' | 'desc'
}

export interface VariantBlock {
  variant: BenchmarkVariantDto
  runs: BenchmarkRunDto[]
  medians: Partial<Record<MetricKey, number | null>>
  spreads: Partial<Record<MetricKey, { min: number; max: number } | null>>
  rate: { passed: number; checked: number } | null
  /** Per measure, whether its median may rank: false when it rests on failed runs only. */
  eligible: Partial<Record<MetricKey, boolean>>
  /**
   * Which runs the medians stand on, when not all of them: `succeeded` when failed runs were
   * left out, `failed` when no run succeeded and the medians come from failed ones.
   */
  pool: 'succeeded' | 'failed' | null
}

/**
 * Medians follow the rule shared with Compare, the shared page and the slides: runs that succeeded
 * (and passed the check) when there are any, every run otherwise. A run that crashed after thirty
 * seconds would otherwise make its variant look fast, and the sort name another winner than the
 * slides. Each run keeps its own row, so nothing measured disappears.
 */
export function variantBlocks(benchmark: BenchmarkDto, sort: Sort | null): VariantBlock[] {
  const blocks = benchmark.variants.map((variant): VariantBlock => {
    const runs = benchmark.runs.filter((run) => run.variantId === variant.id).sort((a, b) => a.repetition - b.repetition)
    const medians: VariantBlock['medians'] = {}
    const spreads: VariantBlock['spreads'] = {}
    const eligible: VariantBlock['eligible'] = {}
    for (const key of METRIC_KEYS) {
      const measure = variantMeasure(benchmark, variant.id, key)
      medians[key] = measure.median
      spreads[key] = measure.count > 1 && measure.min !== null && measure.max !== null ? { min: measure.min, max: measure.max } : null
      eligible[key] = measure.eligible
    }
    const succeeded = eligibleRuns(benchmark, runs).length
    const settled = runs.filter((run) => run.metrics !== null).length
    const pool = succeeded === 0 ? (settled > 0 ? 'failed' : null) : succeeded < settled ? 'succeeded' : null
    return { variant, runs, medians, spreads, rate: passRate(benchmark, runs), eligible, pool }
  })
  if (!sort) return blocks
  // Unreported values sink to the bottom whatever the direction: they are not small, they are
  // unknown. Medians of failed runs only come just before them, as on the slides' ranking: a run
  // that crashed after twenty seconds is not the fastest one.
  const standing = (block: VariantBlock) => ((block.medians[sort.key] ?? null) === null ? 2 : block.eligible[sort.key] ? 0 : 1)
  return [...blocks].sort((a, b) => {
    const rank = standing(a) - standing(b)
    if (rank !== 0) return rank
    const left = a.medians[sort.key] ?? null
    const right = b.medians[sort.key] ?? null
    if (left === null || right === null) return 0
    return sort.direction === 'asc' ? left - right : right - left
  })
}

/**
 * Measures read together, so the header can name the family once and a rule can separate them:
 * scanning a row of fifteen numbers is easier when "how long", "how much" and "how many tools"
 * each sit in their own band. Single-measure families keep one header cell.
 */
const GROUPS: { label: MessageKey | null; keys: MetricKey[] }[] = [
  { label: null, keys: ['rating'] },
  { label: 'benchmark.table.group.time', keys: ['durationMs', 'waitingMs', 'firstTextMs'] },
  { label: 'benchmark.table.group.tokens', keys: ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] },
  { label: null, keys: ['costUsd'] },
  { label: 'benchmark.table.group.tools', keys: ['toolCalls', 'toolErrors', 'toolDurationMs'] },
  { label: 'benchmark.table.group.output', keys: ['assistantMessages', 'outputChars', 'contextTokens'] },
]

/** Inside a family the header already says "Tokens" or "Tools": the column only names its part. */
const SHORT_LABELS: Partial<Record<MetricKey, MessageKey>> = {
  inputTokens: 'benchmark.table.short.input',
  outputTokens: 'benchmark.table.short.output',
  cacheReadTokens: 'benchmark.table.short.cacheRead',
  cacheCreationTokens: 'benchmark.table.short.cacheWrite',
  toolCalls: 'benchmark.table.short.calls',
  toolErrors: 'benchmark.table.short.errors',
  toolDurationMs: 'benchmark.table.short.toolTime',
}

/** Counts that run to millions read better as "8.35 M"; the exact value stays in the tooltip. */
const COMPACT = new Set<MetricKey>(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'outputChars', 'contextTokens'])

function compactValue(key: MetricKey, value: number | null, lang: string): string {
  if (value === null || !COMPACT.has(key) || Math.abs(value) < 10_000) return formatMetric(key, value, lang)
  return new Intl.NumberFormat(lang, { notation: 'compact', maximumSignificantDigits: 3 }).format(value)
}

/**
 * The measurements: one line per variant, so a model reads left to right in a single row, and its
 * runs below it in a lighter type when it ran more than once. Columns are grouped by family and
 * right-aligned with their numbers, the best value of each directional measure stands out, and
 * zeros step back so differences show first.
 */
export function MeasuresTable({ benchmark, blocks, metricKeys, sort, onSort, selection, onToggleCompared, nameOf }: {
  benchmark: BenchmarkDto
  blocks: VariantBlock[]
  metricKeys: MetricKey[]
  sort: Sort | null
  onSort: (key: MetricKey) => void
  selection: string[]
  onToggleCompared: (variantId: string) => void
  nameOf: (variantId: string) => { label: string; text: string }
}) {
  const t = useTranslate()
  const lang = locale()
  const checked = Boolean(benchmark.checkScript)
  const pickable = benchmark.variants.length > 2
  const groups = GROUPS.map((group) => ({ ...group, keys: group.keys.filter((key) => metricKeys.includes(key)) })).filter((group) => group.keys.length > 0)
  const firstOfGroup = new Set(groups.map((group) => group.keys[0]!))

  // Best value per directional measure, among medians that may rank; a lone contender wins nothing.
  const best = new Map<MetricKey, number>()
  for (const key of metricKeys) {
    const direction = BENCHMARK_METRIC_DIRECTIONS[key]
    const values = blocks.filter((block) => block.eligible[key] && (block.medians[key] ?? null) !== null).map((block) => block.medians[key]!)
    if (!direction || values.length < 2) continue
    best.set(key, direction === 'lower' ? Math.min(...values) : Math.max(...values))
  }

  const sortButton = (key: MetricKey) => {
    const short = SHORT_LABELS[key]
    return (
      <button type="button" className="inline-flex items-center gap-1 hover:text-ink" onClick={() => onSort(key)} aria-label={t(METRIC_LABELS[key])} title={`${t(METRIC_LABELS[key])} · ${t('benchmark.table.sortHint')}`}>
        {sort?.key === key ? (sort.direction === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />) : null}
        {t(short ?? METRIC_LABELS[key])}
      </button>
    )
  }
  const ariaSort = (key: MetricKey) => (sort?.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined)
  const edge = (key: MetricKey) => (firstOfGroup.has(key) ? 'border-l border-line' : null)

  const metricCell = (key: MetricKey, value: number | null, isBest: boolean, extra?: ReactNode, title?: string, counts = true) => (
    <td
      key={key}
      data-metric={key}
      className={cx('px-3 py-2 text-right tabular-nums whitespace-nowrap', edge(key), (value === 0 || !counts) && 'text-ink-faint', !counts && 'italic', isBest && 'font-semibold text-accent')}
      title={title ?? (COMPACT.has(key) && value !== null && Math.abs(value) >= 10_000 ? formatMetric(key, value, lang) : undefined)}
    >
      {isBest ? <span className="sr-only">{t('benchmark.table.best')} </span> : null}
      {compactValue(key, value, lang)}
      {extra}
    </td>
  )

  return (
    <div className="overflow-x-auto rounded-lg border border-line" data-benchmark-results>
      <table className="w-full min-w-max border-collapse text-sm">
        <thead className="bg-surface-high text-xs text-ink-faint">
          <tr>
            <th scope="col" rowSpan={2} className="sticky left-0 z-10 bg-surface-high px-3 py-2 text-left align-bottom font-medium">{t('benchmark.table.variant')}</th>
            <th scope="col" rowSpan={2} className="px-3 py-2 text-left align-bottom font-medium">{t('benchmark.table.status')}</th>
            {checked ? <th scope="col" rowSpan={2} className="px-3 py-2 text-left align-bottom font-medium">{t('benchmark.table.check')}</th> : null}
            {groups.map((group) => group.label ? (
              <th key={group.keys[0]} scope="colgroup" colSpan={group.keys.length} className="border-l border-line px-3 pt-2 pb-0.5 text-left font-semibold tracking-wide text-ink-soft uppercase">
                {t(group.label)}
              </th>
            ) : (
              <th key={group.keys[0]} scope="col" rowSpan={2} aria-sort={ariaSort(group.keys[0]!)} className="border-l border-line px-3 py-2 text-right align-bottom font-medium whitespace-nowrap">
                {sortButton(group.keys[0]!)}
              </th>
            ))}
          </tr>
          <tr>
            {groups.filter((group) => group.label).flatMap((group) => group.keys.map((key) => (
              <th key={key} scope="col" aria-sort={ariaSort(key)} className={cx('px-3 pt-0.5 pb-2 text-right font-medium whitespace-nowrap', edge(key))}>
                {sortButton(key)}
              </th>
            )))}
          </tr>
        </thead>
        <tbody>
          {blocks.map((block, index) => {
            const { variant, runs, medians, spreads, rate, pool } = block
            const single = runs.length <= 1 ? runs[0] ?? null : null
            const zebra = index % 2 === 1 ? 'bg-sunken/50' : 'bg-surface'
            const isBest = (key: MetricKey) => block.eligible[key] === true && best.has(key) && medians[key] === best.get(key)
            const head = (
              <th scope="rowgroup" className="sticky left-0 z-[1] bg-inherit px-3 py-2 text-left font-normal">
                <div className="flex items-center gap-2">
                  {pickable ? (
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-accent"
                      checked={selection.includes(variant.id)}
                      disabled={!selection.includes(variant.id) && selection.length >= MAX_BENCHMARK_COMPARISON_VARIANTS}
                      aria-label={t('benchmark.compare.toggle', { name: nameOf(variant.id).text })}
                      onChange={() => onToggleCompared(variant.id)}
                      data-compare-check={variant.id}
                    />
                  ) : null}
                  <AgentIcon agent={variantAgent(variant)} size={16} />
                  {/* Narrow on a phone, where this column stays pinned beside the numbers. */}
                  <div className="min-w-0 max-sm:max-w-36">
                    <div className="flex items-center gap-1.5 font-semibold text-ink">
                      <span className="truncate sm:whitespace-nowrap">{nameOf(variant.id).label}</span>
                      {single?.conversationId ? (
                        <Link to={conversationPath({ id: single.conversationId, projectId: null })} className="text-ink-faint hover:text-accent" aria-label={t('benchmark.table.openRun')} title={t('benchmark.table.openRun')}>
                          <ExternalLink size={12} />
                        </Link>
                      ) : null}
                    </div>
                    {/* The exact model, the CLI release and when a variant joined, on a quiet second line. */}
                    <div className="truncate text-[0.6875rem] text-ink-faint sm:overflow-visible sm:whitespace-nowrap">
                      {[
                        AGENT_LABELS[variantAgent(variant)],
                        variant.technicalLabel !== variant.label ? variant.technicalLabel : null,
                        modelsAccount(variant.config) ? t('benchmark.table.account') : null,
                        cliVersion(runs) ? `v${cliVersion(runs)}` : null,
                        variant.addedAt ? t('benchmark.page.added', { date: new Date(variant.addedAt).toLocaleDateString(lang, { dateStyle: 'medium' }) }) : null,
                      ].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </div>
              </th>
            )
            return (
              <Fragment key={variant.id}>
                {single ? (
                  <tr className={cx('border-t border-line hover:bg-surface-high/70', zebra)} data-benchmark-group={variant.id} data-benchmark-run={single.status}>
                    {head}
                    <td className="px-3 py-2 whitespace-nowrap"><RunStatus run={single} /></td>
                    {checked ? <CheckCell run={single} /> : null}
                    {/* A failed run's numbers stay readable but step back: they never rank. */}
                    {metricKeys.map((key) => metricCell(key, metricValue(single, key), isBest(key), null, key === 'toolCalls' ? toolBreakdown(single) : undefined, key === 'rating' || block.eligible[key] !== false || metricValue(single, key) === null))}
                  </tr>
                ) : (
                  <>
                    <tr className={cx('border-t border-line hover:bg-surface-high/70', zebra)} data-benchmark-group={variant.id} data-benchmark-median data-median-pool={pool ?? undefined}>
                      {head}
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1" title={t('benchmark.table.median')}>
                          {runs.map((run) => <span key={run.id} aria-hidden className={cx('size-1.5 rounded-full', RUN_TONES[run.status])} />)}
                          <span className="ml-1 text-xs text-ink-soft">{t('benchmark.table.median')}</span>
                        </span>
                        {pool ? (
                          <span className={cx('block text-[0.6875rem]', pool === 'failed' ? 'text-caution' : 'text-ink-faint')}>
                            {t(pool === 'failed' ? 'benchmark.compare.failedOnly' : 'benchmark.table.medianSucceeded')}
                          </span>
                        ) : null}
                      </td>
                      {checked ? (
                        <td className="px-3 py-2 whitespace-nowrap">
                          {rate && rate.checked > 0 ? (
                            <Badge tone={rate.passed === rate.checked ? 'positive' : rate.passed === 0 ? 'critical' : 'caution'}>
                              {t('benchmark.table.passRate', { passed: rate.passed, checked: rate.checked })}
                            </Badge>
                          ) : <span className="text-ink-faint">—</span>}
                        </td>
                      ) : null}
                      {metricKeys.map((key) => {
                        const range = spreads[key]
                        return metricCell(key, medians[key] ?? null, isBest(key), range ? (
                          <span className="block text-[0.6875rem] font-normal text-ink-faint" title={t('benchmark.table.spread')}>
                            {compactValue(key, range.min, lang)} – {compactValue(key, range.max, lang)}
                          </span>
                        ) : null, undefined, pool !== 'failed')
                      })}
                    </tr>
                    {runs.map((run) => (
                      <tr key={run.id} className={cx('text-xs text-ink-soft', zebra)} data-benchmark-run={run.status}>
                        <td className="sticky left-0 z-[1] bg-inherit py-1 pr-3 pl-10 whitespace-nowrap">
                          {run.conversationId ? (
                            <Link to={conversationPath({ id: run.conversationId, projectId: null })} className="inline-flex items-center gap-1 text-accent hover:underline">
                              {t('benchmark.table.repetition', { n: run.repetition })}
                              <ExternalLink size={11} />
                            </Link>
                          ) : (
                            <span className="text-ink-faint">{t('benchmark.table.repetition', { n: run.repetition })}</span>
                          )}
                        </td>
                        <td className="px-3 py-1 whitespace-nowrap"><RunStatus run={run} /></td>
                        {checked ? <CheckCell run={run} /> : null}
                        {metricKeys.map((key) => {
                          const value = metricValue(run, key)
                          return (
                            <td key={key} data-metric={key} className={cx('px-3 py-1 text-right tabular-nums whitespace-nowrap', edge(key), value === 0 && 'text-ink-faint')}
                              title={key === 'toolCalls' ? toolBreakdown(run) : COMPACT.has(key) && value !== null && Math.abs(value) >= 10_000 ? formatMetric(key, value, lang) : undefined}>
                              {compactValue(key, value, lang)}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function CheckCell({ run }: { run: BenchmarkRunDto }) {
  const t = useTranslate()
  return (
    <td className="px-3 py-2 whitespace-nowrap" data-benchmark-check={run.check ? (run.check.passed ? 'passed' : 'failed') : 'none'}>
      {run.check ? (
        <span className={cx('inline-flex items-center gap-1', run.check.passed ? 'text-positive' : 'text-critical')} title={checkSummary(run)}>
          {run.check.passed ? <Check size={13} /> : <X size={13} />}
          {t(run.check.passed ? 'benchmark.check.passed' : run.check.timedOut ? 'benchmark.check.timedOut' : 'benchmark.check.failed', { code: run.check.exitCode ?? '?' })}
        </span>
      ) : <span className="text-ink-faint">—</span>}
    </td>
  )
}

/**
 * Run state, plus the one live signal that needs the viewer: a session waiting for a permission
 * or an answer. Unattended runs stall there, so the link leads straight to the request.
 */
function RunStatus({ run }: { run: BenchmarkRunDto }) {
  const t = useTranslate()
  const live = useLiveStatus(run.conversationId ?? '')
  if (run.status === 'running' && live === 'awaiting_input' && run.conversationId) {
    return (
      <Link to={conversationPath({ id: run.conversationId, projectId: null })} className="inline-flex items-center gap-1.5 text-caution hover:underline" data-benchmark-waiting>
        <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-caution" />
        {t('benchmark.run.awaitingInput')}
      </Link>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5" title={run.error ?? undefined}>
      <span aria-hidden className={cx('size-1.5 rounded-full', RUN_TONES[run.status])} />
      {t(RUN_STATUS_LABELS[run.status])}
    </span>
  )
}

/** CLI release shared by a variant's runs; the first one known when they differ. */
function cliVersion(runs: BenchmarkRunDto[]): string | null {
  return runs.map((run) => run.cliVersion).find((value) => value !== null) ?? null
}

/** First lines of what the script printed, to see why a run failed without opening it. */
function checkSummary(run: BenchmarkRunDto): string | undefined {
  const text = [run.check?.stdout, run.check?.stderr].filter(Boolean).join('\n').trim()
  return text ? text.split('\n').slice(0, 8).join('\n') : undefined
}

function toolBreakdown(run: BenchmarkRunDto): string | undefined {
  const entries = Object.entries(run.metrics?.toolsByName ?? {}).sort((a, b) => b[1] - a[1])
  return entries.length ? entries.map(([name, count]) => `${name} ${count}`).join(' · ') : undefined
}
