import { ArrowDown, ArrowLeft, ArrowUp, ExternalLink, FlaskConical, Square, Trash2 } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { conversationPath, variantAgent, type BenchmarkDto, type BenchmarkRunDto, type BenchmarkVariant } from '@sillage/protocol'
import { AGENT_LABELS, AgentIcon } from '../components/AgentIcon'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { Badge, Banner, Button, ConfirmDialog, EmptyState, IconButton, cx } from '../components/ui'
import {
  BENCHMARK_STATE_LABELS,
  METRIC_KEYS,
  METRIC_LABELS,
  RUN_STATUS_LABELS,
  benchmarkProgress,
  benchmarkState,
  formatMetric,
  median,
  metricValue,
  useBenchmarks,
  useCancelBenchmark,
  useDeleteBenchmark,
  type MetricKey,
} from '../lib/benchmarks'
import { modelsAccount } from '../lib/agents'
import { relativeDate } from '../lib/dates'
import { locale, useTranslate } from '../lib/i18n'
import { useSidebarHidden } from '../lib/sidebar'
import { BENCHMARK_STATE_TONES } from './BenchmarksPage'

const RUN_DOTS: Record<BenchmarkRunDto['status'], string> = {
  pending: 'bg-line-strong',
  running: 'bg-accent animate-pulse',
  succeeded: 'bg-positive',
  failed: 'bg-critical',
  timed_out: 'bg-caution',
  cancelled: 'bg-line-strong',
}

interface Sort {
  key: MetricKey
  direction: 'asc' | 'desc'
}

/**
 * A benchmark's measurements: one block per variant, one row per run, a median row when a variant
 * ran several times. Sorting reorders variants by their median so the question “which is fastest”
 * has a one-click answer; rows inside a variant stay in repetition order.
 */
export function BenchmarkPage() {
  const { id } = useParams()
  const t = useTranslate()
  const navigate = useNavigate()
  const sidebarHidden = useSidebarHidden()
  const { data: benchmarks, isPending, isError } = useBenchmarks()
  const cancel = useCancelBenchmark()
  const remove = useDeleteBenchmark()
  const [confirming, setConfirming] = useState(false)
  const [sort, setSort] = useState<Sort | null>(null)
  const benchmark = benchmarks?.find((entry) => entry.id === id)

  const blocks = useMemo(() => (benchmark ? variantBlocks(benchmark, sort) : []), [benchmark, sort])

  if (isPending) return <p role="status" className="p-6 text-sm text-ink-faint">{t('schedule.loading')}</p>
  if (isError) return <div className="p-6"><Banner>{t('benchmark.loadError')}</Banner></div>
  if (!benchmark) {
    return (
      <EmptyState
        icon={<FlaskConical size={22} />}
        title={t('benchmark.notFound')}
        action={<Link to="/benchmarks"><Button size="sm" variant="secondary">{t('benchmark.back')}</Button></Link>}
      />
    )
  }

  const state = benchmarkState(benchmark)
  const progress = benchmarkProgress(benchmark)
  const error = cancel.error ?? remove.error
  const lang = locale()

  const toggleSort = (key: MetricKey) =>
    setSort((current) => (current?.key === key ? (current.direction === 'asc' ? { key, direction: 'desc' } : null) : { key, direction: 'asc' }))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={cx('flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-3 md:px-6', sidebarHidden && 'md:pl-14')}>
        <MobileNavigationButton />
        <Link to="/benchmarks"><IconButton label={t('benchmark.back')}><ArrowLeft size={18} /></IconButton></Link>
        <FlaskConical size={19} className="shrink-0 text-ink-faint" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">{benchmark.name}</h1>
          <p className="truncate text-xs text-ink-faint">
            {t('benchmark.summary', { variants: benchmark.variants.length, done: progress.done, total: progress.total })} · {relativeDate(benchmark.createdAt)}
          </p>
        </div>
        <Badge tone={BENCHMARK_STATE_TONES[state]}>{t(BENCHMARK_STATE_LABELS[state])}</Badge>
        {state === 'running' ? (
          <Button size="sm" variant="secondary" icon={<Square size={14} />} busy={cancel.isPending} onClick={() => cancel.mutate(benchmark.id)}>
            {t('benchmark.cancel')}
          </Button>
        ) : null}
        <IconButton label={t('benchmark.delete')} onClick={() => setConfirming(true)}><Trash2 size={16} /></IconButton>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-5">
          {error ? <Banner>{error.message}</Banner> : null}

          <details className="rounded-lg border border-line">
            <summary className="cursor-pointer px-4 py-2.5 text-sm text-ink-soft">{t('benchmark.form.prompt')}</summary>
            <p className="border-t border-line px-4 py-3 text-sm whitespace-pre-wrap text-ink-soft">{benchmark.prompt}</p>
          </details>

          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-soft">
            <Fact label={t('benchmark.form.repetitions')}>{benchmark.repetitions}</Fact>
            <Fact label={t('benchmark.form.concurrency')}>{t(benchmark.concurrency === 'parallel' ? 'benchmark.form.concurrency.parallel' : 'benchmark.form.concurrency.sequential')}</Fact>
            <Fact label={t('schedule.form.maxDuration')}>{benchmark.maxDurationMinutes}</Fact>
          </dl>

          <div className="overflow-x-auto rounded-lg border border-line" data-benchmark-results>
            <table className="w-full min-w-max border-collapse text-sm">
              <thead>
                <tr className="bg-surface-high text-left text-xs text-ink-faint">
                  <th scope="col" className="sticky left-0 z-10 bg-surface-high px-3 py-2 font-medium">{t('benchmark.table.run')}</th>
                  <th scope="col" className="px-3 py-2 font-medium">{t('benchmark.table.status')}</th>
                  {METRIC_KEYS.map((key) => (
                    <th key={key} scope="col" className="px-3 py-2 font-medium whitespace-nowrap" aria-sort={sort?.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
                      <button type="button" className="inline-flex items-center gap-1 hover:text-ink" onClick={() => toggleSort(key)} title={t('benchmark.table.sortHint')}>
                        {t(METRIC_LABELS[key])}
                        {sort?.key === key ? (sort.direction === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />) : null}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {blocks.map(({ variant, runs, medians }) => (
                  <Fragment key={variant.id}>
                    <tr className="border-t border-line bg-sunken/60">
                      <th scope="rowgroup" colSpan={2 + METRIC_KEYS.length} className="sticky left-0 px-3 py-2 text-left font-medium">
                        <span className="inline-flex items-center gap-2">
                          <AgentIcon agent={variantAgent(variant)} size={14} />
                          <span className="text-ink-faint">{AGENT_LABELS[variantAgent(variant)]}</span>
                          <span>{variant.label}</span>
                          {/* An alias such as “default” names no generation: show what the CLI announced. */}
                          {announcedModel(runs, variant) ? <span className="text-xs text-ink-faint">· {announcedModel(runs, variant)}</span> : null}
                          {modelsAccount(variant.config) ? <span className="text-xs text-ink-faint">· {t('benchmark.table.account')}</span> : null}
                        </span>
                      </th>
                    </tr>
                    {runs.map((run) => (
                      <tr key={run.id} className="border-t border-line/60" data-benchmark-run={run.status}>
                        <td className="sticky left-0 bg-surface px-3 py-1.5 whitespace-nowrap">
                          {run.conversationId ? (
                            <Link to={conversationPath({ id: run.conversationId, projectId: null })} className="inline-flex items-center gap-1 text-accent hover:underline">
                              {t('benchmark.table.repetition', { n: run.repetition })}
                              <ExternalLink size={11} />
                            </Link>
                          ) : (
                            <span className="text-ink-faint">{t('benchmark.table.repetition', { n: run.repetition })}</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5" title={run.error ?? undefined}>
                            <span aria-hidden className={cx('size-1.5 rounded-full', RUN_DOTS[run.status])} />
                            {t(RUN_STATUS_LABELS[run.status])}
                          </span>
                        </td>
                        {METRIC_KEYS.map((key) => (
                          <td key={key} className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap" title={key === 'toolCalls' ? toolBreakdown(run) : undefined}>
                            {formatMetric(key, metricValue(run.metrics, key), lang)}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {runs.length > 1 ? (
                      <tr className="border-t border-line/60 text-ink-soft" data-benchmark-median>
                        <td className="sticky left-0 bg-surface px-3 py-1.5 text-xs font-medium whitespace-nowrap">{t('benchmark.table.median')}</td>
                        <td />
                        {METRIC_KEYS.map((key) => (
                          <td key={key} className="px-3 py-1.5 text-right text-xs font-medium tabular-nums whitespace-nowrap">
                            {formatMetric(key, medians[key] ?? null, lang)}
                          </td>
                        ))}
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-faint">{t('benchmark.table.legend')}</p>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('benchmark.delete.title', { name: benchmark.name })}
        confirmLabel={t('shell.delete')}
        tone="critical"
        busy={remove.isPending}
        onConfirm={() => remove.mutate(benchmark.id, { onSuccess: () => { setConfirming(false); navigate('/benchmarks', { replace: true }) } })}
      >
        <p>{t('benchmark.delete.body')}</p>
      </ConfirmDialog>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="font-medium text-ink">{children}</dd>
    </div>
  )
}

/** Model reported at session start when it adds to the configured value. */
function announcedModel(runs: BenchmarkRunDto[], variant: BenchmarkVariant): string | null {
  const model = runs.map((run) => run.metrics?.model ?? null).find((value) => value !== null) ?? null
  return model && model !== variant.config.model ? model : null
}

function toolBreakdown(run: BenchmarkRunDto): string | undefined {
  const entries = Object.entries(run.metrics?.toolsByName ?? {}).sort((a, b) => b[1] - a[1])
  return entries.length ? entries.map(([name, count]) => `${name} ${count}`).join(' · ') : undefined
}

interface VariantBlock {
  variant: BenchmarkVariant
  runs: BenchmarkRunDto[]
  medians: Partial<Record<MetricKey, number | null>>
}

function variantBlocks(benchmark: BenchmarkDto, sort: Sort | null): VariantBlock[] {
  const blocks = benchmark.variants.map((variant): VariantBlock => {
    const runs = benchmark.runs.filter((run) => run.variantId === variant.id).sort((a, b) => a.repetition - b.repetition)
    const medians: VariantBlock['medians'] = {}
    for (const key of METRIC_KEYS) medians[key] = median(runs.map((run) => metricValue(run.metrics, key)))
    return { variant, runs, medians }
  })
  if (!sort) return blocks
  // Unreported values sink to the bottom whatever the direction: they are not small, they are unknown.
  return [...blocks].sort((a, b) => {
    const left = a.medians[sort.key] ?? null
    const right = b.medians[sort.key] ?? null
    if (left === null && right === null) return 0
    if (left === null) return 1
    if (right === null) return -1
    return sort.direction === 'asc' ? left - right : right - left
  })
}
