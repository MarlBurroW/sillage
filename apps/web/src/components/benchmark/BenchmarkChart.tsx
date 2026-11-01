import { useId, useState, type ReactNode } from 'react'
import type { BenchmarkRunDto } from '@sillage/protocol'
import { METRIC_LABELS, formatMetric, median, metricValue, spread, type MetricKey } from '../../lib/benchmarks'
import { locale, useTranslate } from '../../lib/i18n'
import { Select } from '../ui'

export interface ChartRow {
  id: string
  /** Name or letter, already chosen by the page (blind review hides names). */
  label: ReactNode
  /** Plain text for the tooltip and accessible names. */
  text: string
  runs: BenchmarkRunDto[]
}

/**
 * One measure across variants: a bar per variant at its median, a dot per run so the spread shows,
 * the value at the bar's tip. A single series, so one hue and no legend; the measure's name is the
 * title. Hovering or focusing a row shows its median, range and run count; the table on the
 * Measurements tab stays the full, accessible view of the same numbers.
 */
export function BenchmarkChart({ rows, metrics }: { rows: ChartRow[]; metrics: MetricKey[] }) {
  const t = useTranslate()
  const lang = locale()
  const titleId = useId()
  const [metric, setMetric] = useState<MetricKey>(metrics.includes('durationMs') ? 'durationMs' : metrics[0]!)
  const [hovered, setHovered] = useState<string | null>(null)

  const data = rows.map((row) => {
    const values = row.runs.map((run) => metricValue(run, metric)).filter((value): value is number => value !== null)
    return { row, values, median: median(values), range: spread(values) }
  })
  const max = Math.max(0, ...data.flatMap((entry) => entry.values))
  // Scale on a rounded ceiling so the axis reads in clean numbers.
  const ceiling = niceCeiling(max)
  const position = (value: number) => (ceiling > 0 ? (value / ceiling) * 100 : 0)
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
          {data.map(({ row, values, median: middle, range }) => (
            <div key={row.id} className="contents">
              <div className="min-w-0 truncate text-sm text-ink-soft">{row.label}</div>
              <div
                className="relative h-9 rounded outline-none focus-visible:outline-2 focus-visible:outline-accent"
                tabIndex={0}
                aria-label={`${row.text} : ${formatMetric(metric, middle, lang)}`}
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
                      className="absolute top-1/2 h-5 -translate-y-1/2 rounded-r bg-accent"
                      style={{ left: 0, width: `max(2px, ${position(middle)}%)` }}
                    />
                    <span
                      aria-hidden
                      className="absolute top-1/2 -translate-y-1/2 pl-1.5 text-xs tabular-nums whitespace-nowrap text-ink-soft"
                      style={{ left: `${Math.min(position(middle), 82)}%`, marginLeft: position(middle) > 82 ? '-4.5rem' : undefined }}
                    >
                      {formatMetric(metric, middle, lang)}
                    </span>
                  </>
                ) : (
                  <span className="absolute top-1/2 left-1 -translate-y-1/2 text-xs text-ink-faint">—</span>
                )}
                {/* Each run as a dot ringed in the surface color, so repetitions stay visible over the bar. */}
                {values.length > 1 ? values.map((value, index) => (
                  <span
                    key={index}
                    aria-hidden
                    className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink ring-2 ring-surface"
                    style={{ left: `${position(value)}%` }}
                  />
                )) : null}
                {hovered === row.id ? (
                  <div role="tooltip" className="surface absolute top-full left-0 z-20 mt-1 min-w-44 rounded-md border border-line px-3 py-2 text-xs shadow-pop">
                    <p className="font-semibold tabular-nums">{formatMetric(metric, middle, lang)}</p>
                    <p className="text-ink-soft">{row.text}</p>
                    {range ? (
                      <p className="mt-1 text-ink-faint tabular-nums">{t('benchmark.chart.range', { min: formatMetric(metric, range.min, lang), max: formatMetric(metric, range.max, lang) })}</p>
                    ) : null}
                    <p className="text-ink-faint">{t('benchmark.chart.runs', { count: values.length })}</p>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          <div />
          <div className="relative h-4 text-[0.6875rem] text-ink-faint tabular-nums">
            {ticks.map((tick, index) => (
              <span
                key={tick}
                className="absolute whitespace-nowrap"
                style={{ left: `${position(tick)}%`, transform: index === 0 ? undefined : index === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}
              >
                {formatMetric(metric, tick, lang)}
              </span>
            ))}
          </div>
        </div>
      )}
      <p className="text-xs text-ink-faint">{t('benchmark.chart.legend')}</p>
    </section>
  )
}

/** 1, 2, 2.5 or 5 times a power of ten: axis ends a reader can say aloud. */
function niceCeiling(value: number): number {
  if (value <= 0) return 0
  const power = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * power >= value) ?? 10
  return step * power
}
