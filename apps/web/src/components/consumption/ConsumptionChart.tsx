import type { AgentKind, ConsumptionReport } from '@sillage/protocol'
import { useId, useState, type KeyboardEvent } from 'react'
import { SERIES_AGENTS, formatBucket, formatCount, formatUsd, totalTokens } from '../../lib/consumption'
import { locale, useTranslate } from '../../lib/i18n'
import { AGENT_LABELS } from '../AgentIcon'
import { cx } from '../ui'

export type ChartMetric = 'cost' | 'tokens'

/** Axis ceiling on a round number, so the two gridlines read without arithmetic. */
function niceCeiling(max: number): number {
  if (max <= 0) return 0
  const magnitude = 10 ** Math.floor(Math.log10(max))
  return [1, 1.5, 2, 3, 4, 5, 6, 8, 10].map((step) => step * magnitude).find((step) => step >= max) ?? 10 * magnitude
}

/**
 * Consumption over time, one stacked bar per day or month, one color per CLI. A CLI keeps its
 * color and its place in the stack whatever the period holds. Pointing at a bar, or moving along
 * them with the arrow keys, details it; the tables below the chart carry the same figures.
 */
export function ConsumptionChart({ series, metric }: { series: ConsumptionReport['series']; metric: ChartMetric }) {
  const t = useTranslate()
  const lang = locale()
  const hintId = useId()
  const [active, setActive] = useState<number | null>(null)

  const valueOf = (amount: ConsumptionReport['series'][number]['agents'][number]) => (metric === 'cost' ? amount.costUsd : totalTokens(amount))
  const format = (value: number) => (metric === 'cost' ? formatUsd(value, lang) : formatCount(value, lang))
  const buckets = series.map((entry) => {
    const parts = SERIES_AGENTS.flatMap((agent) => {
      const amount = entry.agents.find((candidate) => candidate.agent === agent)
      const value = amount ? valueOf(amount) : 0
      return value > 0 ? [{ agent, value }] : []
    })
    return { date: entry.date, parts, total: parts.reduce((sum, part) => sum + part.value, 0) }
  })
  const present = SERIES_AGENTS.filter((agent) => buckets.some((bucket) => bucket.parts.some((part) => part.agent === agent)))
  const ceiling = niceCeiling(Math.max(0, ...buckets.map((bucket) => bucket.total)))
  // A label per bar would collide: a handful, evenly spread, the last one included.
  const every = Math.max(1, Math.ceil(buckets.length / 6))
  const labeled = (index: number) => (buckets.length - 1 - index) % every === 0
  const shown = active === null ? null : buckets[active]

  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (event.key === 'Escape') setActive(null)
    if (!step || !buckets.length) return
    event.preventDefault()
    setActive((current) => Math.min(buckets.length - 1, Math.max(0, (current ?? (step > 0 ? -1 : buckets.length)) + step)))
  }

  if (ceiling === 0) return <p className="py-10 text-center text-sm text-ink-faint">{t('consumption.chart.empty')}</p>

  return (
    <div className="consumption-viz flex flex-col gap-3" data-consumption-chart={metric}>
      {present.length > 1 ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft" aria-label={t('consumption.chart.legend')}>
          {present.map((agent) => (
            <li key={agent} className="flex items-center gap-1.5"><Swatch agent={agent} />{AGENT_LABELS[agent]}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex gap-2">
        <div aria-hidden className="relative h-48 w-11 shrink-0 text-right text-[0.6875rem] tabular-nums text-ink-faint">
          {[1, 0.5, 0].map((ratio) => (
            <span key={ratio} className="absolute right-0 -translate-y-1/2" style={{ top: `${(1 - ratio) * 100}%` }}>{format(ceiling * ratio)}</span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div
            role="group"
            tabIndex={0}
            aria-label={t('consumption.chart.aria')}
            aria-describedby={hintId}
            onKeyDown={onKeyDown}
            onPointerLeave={() => setActive(null)}
            onBlur={() => setActive(null)}
            className="relative h-48 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
          >
            {[1, 0.5, 0].map((ratio) => (
              <span key={ratio} aria-hidden className={cx('absolute inset-x-0 h-px', ratio === 0 ? 'bg-line-strong' : 'bg-line')} style={{ top: `${(1 - ratio) * 100}%` }} />
            ))}
            <div className={cx('absolute inset-0 flex items-stretch', buckets.length > 45 ? 'gap-px' : 'gap-1')}>
              {buckets.map((bucket, index) => (
                <div
                  key={bucket.date}
                  // The whole column answers, not just the ink: an empty day is still a day to read.
                  onPointerEnter={() => setActive(index)}
                  onPointerDown={() => setActive(index)}
                  className={cx('flex min-w-0 flex-1 flex-col items-center justify-end', active === index && 'bg-surface-high')}
                  data-bucket={bucket.date}
                >
                  <div className="flex w-full max-w-6 flex-col" style={{ height: `${(bucket.total / ceiling) * 100}%` }}>
                    {/* Top of the stack first: it carries the rounded end. */}
                    {[...bucket.parts].reverse().map((part) => (
                      <span key={part.agent} className="consumption-segment" style={{ flexGrow: part.value, flexBasis: 0, background: `var(--series-${part.agent})` }} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {shown && active !== null ? (
              <div
                role="status"
                className="pointer-events-none absolute top-0 z-10 w-max max-w-64 rounded-md border border-line-strong bg-surface-high px-3 py-2 text-xs shadow-card"
                style={active < buckets.length / 2 ? { left: `${((active + 1) / buckets.length) * 100}%`, marginLeft: 6 } : { right: `${((buckets.length - active) / buckets.length) * 100}%`, marginRight: 6 }}
                data-consumption-tooltip
              >
                <p className="font-medium text-ink">{formatBucket(shown.date, lang, true)}</p>
                {shown.parts.length ? (
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {[...shown.parts].reverse().map((part) => (
                      <li key={part.agent} className="flex items-center gap-1.5 text-ink-soft">
                        <Swatch agent={part.agent} />{AGENT_LABELS[part.agent]}
                        <span className="ml-auto pl-4 tabular-nums text-ink">{format(part.value)}</span>
                      </li>
                    ))}
                    {shown.parts.length > 1 ? (
                      <li className="flex border-t border-line pt-1 text-ink-soft">{t('consumption.total')}<span className="ml-auto pl-4 font-medium tabular-nums text-ink">{format(shown.total)}</span></li>
                    ) : null}
                  </ul>
                ) : <p className="mt-1 text-ink-faint">{t('consumption.chart.nothing')}</p>}
              </div>
            ) : null}
          </div>
          <div aria-hidden className={cx('mt-1.5 flex text-[0.6875rem] text-ink-faint', buckets.length > 45 ? 'gap-px' : 'gap-1')}>
            {buckets.map((bucket, index) => (
              <span key={bucket.date} className="relative h-4 min-w-0 flex-1">
                {labeled(index) ? <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap">{formatBucket(bucket.date, lang)}</span> : null}
              </span>
            ))}
          </div>
        </div>
      </div>
      <p id={hintId} className="sr-only">{t('consumption.chart.hint')}</p>
    </div>
  )
}

export function Swatch({ agent }: { agent: AgentKind }) {
  return <span aria-hidden className="consumption-viz size-2.5 shrink-0 rounded-sm" style={{ background: `var(--series-${agent})` }} />
}
