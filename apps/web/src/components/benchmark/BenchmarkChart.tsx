import { useId, useState, type ReactNode } from 'react'
import { eligibleRuns, niceCeiling, variantMeasure, type BenchmarkRunDto } from '@sillage/protocol'
import { METRIC_LABELS, formatMetric, metricValue, type MetricKey } from '../../lib/benchmarks'
import { locale, useTranslate } from '../../lib/i18n'
import { Select, cx } from '../ui'

export interface ChartRow {
  id: string
  /** Name or letter, already chosen by the page (blind review hides names). */
  label: ReactNode
  /** Plain text for the tooltip and accessible names. */
  text: string
  runs: BenchmarkRunDto[]
}

/** Share of the track the axis spans, in percent. */
const AXIS_SPAN = 82

/**
 * One measure across variants: a bar per variant at its median, a dot per run so the spread shows,
 * the value at the bar's tip. A single series, so one hue and no legend; the measure's name is the
 * title. Hovering or focusing a row shows its median, range and run count; the table on the
 * Measurements tab stays the full, accessible view of the same numbers.
 *
 * The median follows the rule shared with Compare, the shared page and the slides: runs that
 * succeeded (and passed the check) when there are any. Runs left out of it stay on the chart as
 * hollow dots, so a fast crash is visible without making its variant look fast.
 */
export function BenchmarkChart({ rows, metrics, emphasis, checkScript }: {
  rows: ChartRow[]
  metrics: MetricKey[]
  /** Variants being compared: their bars keep the accent and the others step back. */
  emphasis?: ReadonlySet<string>
  /** The benchmark's check script: with one, only runs that passed it count towards a median. */
  checkScript: string | null
}) {
  const t = useTranslate()
  const lang = locale()
  const titleId = useId()
  const [metric, setMetric] = useState<MetricKey>(metrics.includes('durationMs') ? 'durationMs' : metrics[0]!)
  const [hovered, setHovered] = useState<string | null>(null)

  const data = rows.map((row) => {
    const measure = variantMeasure({ runs: row.runs, checkScript }, row.id, metric)
    const eligible = new Set(eligibleRuns({ checkScript }, row.runs).map((run) => run.id))
    const dots = row.runs.flatMap((run) => {
      const value = metricValue(run, metric)
      // Out of the median only when some run made it in: otherwise every run counts.
      return value === null ? [] : [{ value, counted: eligible.size === 0 || eligible.has(run.id) }]
    })
    return {
      row,
      dots,
      values: dots.map((dot) => dot.value),
      median: measure.median,
      range: measure.count > 1 && measure.min !== null && measure.max !== null ? { min: measure.min, max: measure.max } : null,
      count: measure.count,
      failedOnly: !measure.eligible && measure.median !== null,
    }
  })
  const hollow = data.some((entry) => entry.dots.some((dot) => !dot.counted))
  const max = Math.max(0, ...data.flatMap((entry) => entry.values))
  // Scale on a rounded ceiling so the axis reads in clean numbers.
  const ceiling = niceCeiling(max)
  // The axis spans part of the track: the rest keeps room for the value written after the last dot.
  const position = (value: number) => (ceiling > 0 ? (value / ceiling) * AXIS_SPAN : 0)
  const ticks = [0, ceiling / 2, ceiling]

  return (
    <section className="flex flex-col gap-4" aria-labelledby={titleId} data-benchmark-chart>
      <Select
        className="max-w-72"
        label={t('benchmark.chart.metric')}
        value={metric}
        onChange={setMetric}
        options={metrics.map((key) => ({ value: key, label: t(METRIC_LABELS[key]) }))}
      />
      <h2 id={titleId} className="text-sm font-medium">{t(METRIC_LABELS[metric])}</h2>

      {ceiling === 0 ? (
        <p className="text-sm text-ink-faint">{t('benchmark.chart.empty')}</p>
      ) : (
        <div className="grid grid-cols-[minmax(6rem,12rem)_1fr] items-center gap-x-3 gap-y-2">
          {data.map(({ row, values, dots, median: middle, range, count, failedOnly }) => {
            const muted = !!emphasis && emphasis.size > 0 && !emphasis.has(row.id)
            return (
            <div key={row.id} className="contents" data-chart-muted={muted || undefined}>
              <div className={cx('min-w-0 truncate text-sm', muted ? 'text-ink-faint' : 'text-ink-soft')}>{row.label}</div>
              <div
                className="relative h-9 rounded outline-none focus-visible:outline-2 focus-visible:outline-accent"
                tabIndex={0}
                aria-label={`${row.text} : ${formatMetric(metric, middle, lang)}${failedOnly ? ` (${t('benchmark.compare.failedOnly')})` : ''}`}
                onPointerEnter={() => setHovered(row.id)}
                onPointerLeave={() => setHovered((current) => (current === row.id ? null : current))}
                onFocus={() => setHovered(row.id)}
                onBlur={() => setHovered((current) => (current === row.id ? null : current))}
                data-chart-row={row.text}
              >
                {/* Recessive hairlines at the ticks, under the marks. */}
                {ticks.map((tick) => (
                  <span key={tick} aria-hidden className="absolute inset-y-0 w-px bg-line" style={{ left: `${position(tick)}%` }} />
                ))}
                {middle !== null ? (
                  <>
                    <span
                      aria-hidden
                      // A median of failed runs only is hatched and quiet, as on the slides: it must not
                      // read as the fastest or cheapest bar of the chart.
                      className={cx('absolute top-1/2 h-5 -translate-y-1/2 rounded-r', failedOnly ? null : muted ? 'bg-line-strong' : 'bg-accent')}
                      style={{
                        left: 0,
                        width: `max(2px, ${position(middle)}%)`,
                        ...(failedOnly ? { background: 'repeating-linear-gradient(135deg, var(--color-line-strong) 0 6px, transparent 6px 12px)' } : {}),
                      }}
                      data-chart-failed-only={failedOnly || undefined}
                    />
                    <span
                      aria-hidden
                      className="absolute top-1/2 -translate-y-1/2 pl-2.5 text-xs tabular-nums whitespace-nowrap text-ink-soft"
                      // After the last run's dot rather than the bar's tip: a slower run would cover the value.
                      style={{ left: `${position(Math.max(middle, ...values))}%` }}
                    >
                      {formatMetric(metric, middle, lang)}
                      {failedOnly ? <span className="text-caution"> · {t('benchmark.compare.failedOnly')}</span> : null}
                    </span>
                  </>
                ) : (
                  <span className="absolute top-1/2 left-1 -translate-y-1/2 text-xs text-ink-faint">—</span>
                )}
                {/* Each run as a dot ringed in the surface color, so repetitions stay visible over the bar; hollow when left out of the median. */}
                {dots.length > 1 ? dots.map((dot, index) => (
                  <span
                    key={index}
                    aria-hidden
                    className={cx(
                      'absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface',
                      dot.counted ? 'bg-ink' : 'border-2 border-ink bg-surface',
                    )}
                    style={{ left: `${position(dot.value)}%` }}
                    data-chart-dot={dot.counted ? 'counted' : 'left-out'}
                  />
                )) : null}
                {hovered === row.id ? (
                  <div role="tooltip" className="surface absolute top-full left-0 z-20 mt-1 min-w-44 rounded-md border border-line px-3 py-2 text-xs shadow-pop">
                    <p className="font-semibold tabular-nums">{formatMetric(metric, middle, lang)}</p>
                    <p className="text-ink-soft">{row.text}</p>
                    {range ? (
                      <p className="mt-1 text-ink-faint tabular-nums">{t('benchmark.chart.range', { min: formatMetric(metric, range.min, lang), max: formatMetric(metric, range.max, lang) })}</p>
                    ) : null}
                    <p className="text-ink-faint">{t('benchmark.chart.runs', { count })}</p>
                    {failedOnly ? <p className="text-caution">{t('benchmark.compare.failedOnly')}</p> : null}
                  </div>
                ) : null}
              </div>
            </div>
            )
          })}
          <div />
          <div className="relative h-4 text-[0.6875rem] text-ink-faint tabular-nums">
            {ticks.map((tick, index) => (
              <span
                key={tick}
                className="absolute whitespace-nowrap"
                style={{ left: `${position(tick)}%`, transform: index === 0 ? undefined : 'translateX(-50%)' }}
              >
                {formatMetric(metric, tick, lang)}
              </span>
            ))}
          </div>
        </div>
      )}
      <p className="text-xs text-ink-faint">{t('benchmark.chart.legend')}</p>
      {hollow ? <p className="text-xs text-ink-faint" data-chart-hollow-legend>{t('benchmark.chart.leftOut')}</p> : null}
      <p className="text-xs text-ink-faint">{t('benchmark.measures.explanation')}</p>
    </section>
  )
}
