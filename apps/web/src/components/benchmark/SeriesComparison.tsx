import { useState } from 'react'
import { Link } from 'react-router-dom'
import { benchmarkPath, variantAgent, type BenchmarkDto } from '@sillage/protocol'
import { METRIC_KEYS, METRIC_LABELS, formatMetric, isOpenRun, median, metricValue, passRate, type MetricKey } from '../../lib/benchmarks'
import { formatDateTime } from '../../lib/schedules'
import { locale, useTranslate } from '../../lib/i18n'
import { AgentIcon } from '../AgentIcon'
import { Select, cx } from '../ui'

/**
 * The same benchmark over time: one column per run of the series, one row per variant, the
 * median of the chosen measure in each cell with the CLI release and announced model that
 * produced it. Variants line up by id because a rerun copies them unchanged.
 */
export function SeriesComparison({ series, current }: { series: BenchmarkDto[]; current: string }) {
  const t = useTranslate()
  const lang = locale()
  const [metric, setMetric] = useState<MetricKey>('durationMs')
  const variants = series[0]?.variants ?? []

  return (
    <section className="flex flex-col gap-4" data-benchmark-series>
      <p className="text-sm text-ink-soft">{t('benchmark.series.description', { count: series.length })}</p>
      <Select
        className="max-w-72"
        label={t('benchmark.chart.metric')}
        value={metric}
        onChange={setMetric}
        options={METRIC_KEYS.map((key) => ({ value: key, label: t(METRIC_LABELS[key]) }))}
      />
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead>
            <tr className="bg-surface-high text-left text-xs text-ink-faint">
              <th scope="col" className="sticky left-0 z-10 bg-surface-high px-3 py-2 font-medium">{t('benchmark.series.variant')}</th>
              {series.map((benchmark) => (
                <th key={benchmark.id} scope="col" className={cx('px-3 py-2 text-right font-medium whitespace-nowrap', benchmark.id === current && 'text-accent')}>
                  {benchmark.id === current ? (
                    <span>{formatDateTime(benchmark.createdAt)}</span>
                  ) : (
                    <Link to={benchmarkPath(benchmark.id)} className="hover:text-ink hover:underline">{formatDateTime(benchmark.createdAt)}</Link>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {variants.map((variant) => (
              <tr key={variant.id} className="border-t border-line/60">
                <th scope="row" className="sticky left-0 bg-surface px-3 py-2 text-left font-medium whitespace-nowrap">
                  <span className="inline-flex items-center gap-2"><AgentIcon agent={variantAgent(variant)} size={14} />{variant.label}</span>
                </th>
                {series.map((benchmark) => {
                  const runs = benchmark.runs.filter((run) => run.variantId === variant.id)
                  const value = median(runs.map((run) => metricValue(run, metric)))
                  const rate = passRate(benchmark, runs)
                  const release = runs.map((run) => run.cliVersion).find(Boolean)
                  const model = runs.map((run) => run.metrics?.model).find(Boolean)
                  const open = runs.some(isOpenRun)
                  return (
                    <td key={benchmark.id} className="px-3 py-2 text-right align-top whitespace-nowrap" data-series-cell={`${benchmark.id}:${variant.id}`}>
                      <span className="block font-medium tabular-nums">{open ? t('benchmark.outputs.pending') : formatMetric(metric, value, lang)}</span>
                      <span className="block text-[0.6875rem] text-ink-faint">
                        {[release ? `v${release}` : null, model, rate && rate.checked > 0 ? t('benchmark.table.passRate', { passed: rate.passed, checked: rate.checked }) : null].filter(Boolean).join(' · ')}
                      </span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
