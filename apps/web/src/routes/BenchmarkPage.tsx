import { Pencil, ArrowDown, ArrowUp, Check, ChevronDown, Download, ExternalLink, Eye, EyeOff, FileText, FlaskConical, RotateCcw, Share2, Square, Trash2, X } from 'lucide-react'
import { Fragment, Suspense, lazy, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { benchmarkPath, startedRepetitions, conversationPath, variantAgent, type BenchmarkDto, type BenchmarkRunDto, type BenchmarkVariant } from '@sillage/protocol'
import { AGENT_LABELS, AgentIcon } from '../components/AgentIcon'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { RunSettingsFields, parseRunSettings, runSettingsDraft, type RunSettingsDraft } from '../components/benchmark/RunSettingsFields'
import { BenchmarkChart } from '../components/benchmark/BenchmarkChart'
import { OutputsViewer } from '../components/benchmark/OutputsViewer'
import { SeriesComparison } from '../components/benchmark/SeriesComparison'
import { Badge, Banner, Button, ConfirmDialog, EmptyState, IconButton, Menu, MenuItem, Tabs, cx } from '../components/ui'
import {
  BENCHMARK_STATE_LABELS,
  METRIC_KEYS,
  METRIC_LABELS,
  RUN_STATUS_LABELS,
  benchmarkCsv,
  benchmarkJson,
  benchmarkSeries,
  benchmarkProgress,
  benchmarkState,
  formatMetric,
  median,
  metricValue,
  passRate,
  spread,
  visibleMetricKeys,
  BENCHMARK_STATE_TONES,
  RUN_TONES,
  useBenchmarks,
  useBlindReview,
  useCancelBenchmark,
  useUpdateBenchmarkSettings,
  useDeleteBenchmark,
  useRerunBenchmark,
  useWaitingRuns,
  type MetricKey,
} from '../lib/benchmarks'
import { modelsAccount } from '../lib/agents'
import { formatBytes } from '../lib/attachments'
import { useLiveStatus } from '../lib/conversation-status'
import { downloadText } from '../lib/download'
import { relativeDate } from '../lib/dates'
import { locale, useTranslate } from '../lib/i18n'

// Only people who share pay for the window: it stays out of the page's chunk.
const BenchmarkShareDialog = lazy(() => import('../components/benchmark/BenchmarkShareDialog'))

type Tab = 'measures' | 'chart' | 'outputs' | 'history'

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
  const { data: benchmarks, isPending, isError } = useBenchmarks()
  const cancel = useCancelBenchmark()
  const updateSettings = useUpdateBenchmarkSettings()
  // Null while the dialog is closed: the draft is taken from the benchmark each time it opens.
  const [settings, setSettings] = useState<RunSettingsDraft | null>(null)
  const remove = useDeleteBenchmark()
  const [confirming, setConfirming] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [sort, setSort] = useState<Sort | null>(null)
  const [tab, setTab] = useState<Tab>('measures')
  const benchmark = benchmarks?.find((entry) => entry.id === id)
  const rerun = useRerunBenchmark()
  const variantIds = useMemo(() => benchmark?.variants.map((variant) => variant.id) ?? [], [benchmark])
  const blind = useBlindReview(id ?? '', variantIds)
  const series = useMemo(() => (benchmark && benchmarks ? benchmarkSeries(benchmarks, benchmark) : []), [benchmark, benchmarks])
  const waitingRuns = useWaitingRuns(benchmarks).filter((entry) => entry.benchmark.id === id)

  const blocks = useMemo(() => (benchmark ? variantBlocks(benchmark, sort) : []), [benchmark, sort])
  const metricKeys = useMemo(() => (benchmark ? visibleMetricKeys(benchmark) : METRIC_KEYS), [benchmark])
  const columnCount = 2 + (benchmark?.checkScript ? 1 : 0) + metricKeys.length

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
  const error = cancel.error ?? remove.error ?? rerun.error
  const minRepetitions = Math.max(1, startedRepetitions(benchmark.runs))
  const parsedSettings = settings ? parseRunSettings(settings, minRepetitions) : null
  // A variant's heading: its letter while blind, the letter beside the name once revealed.
  const nameOf = (variantId: string) => {
    const variant = benchmark.variants.find((entry) => entry.id === variantId)
    const letter = blind.letterOf(variantId)
    if (blind.active) {
      const text = t('benchmark.blind.variant', { letter: letter ?? '?' })
      return { label: text, text }
    }
    const text = letter ? `${letter} · ${variant?.label ?? variantId}` : (variant?.label ?? variantId)
    return { label: text, text }
  }
  const runName = (run: BenchmarkRunDto) => (benchmark.repetitions > 1 ? `${nameOf(run.variantId).text} · ${run.repetition}` : nameOf(run.variantId).text)
  const tabs: { value: Tab; label: string }[] = [
    { value: 'measures', label: t('benchmark.tab.measures') },
    { value: 'chart', label: t('benchmark.tab.chart') },
    { value: 'outputs', label: t('benchmark.tab.outputs') },
    // History only exists once the benchmark has been rerun.
    ...(series.length > 1 ? [{ value: 'history' as const, label: t('benchmark.tab.history', { count: series.length }) }] : []),
  ]
  const shown: Tab = tabs.some((entry) => entry.value === tab) ? tab : 'measures'
  const lang = locale()

  const toggleSort = (key: MetricKey) =>
    setSort((current) => (current?.key === key ? (current.direction === 'asc' ? { key, direction: 'desc' } : null) : { key, direction: 'asc' }))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ConfirmDialog
        open={settings !== null}
        onOpenChange={(open) => { if (!open) setSettings(null) }}
        title={t('benchmark.settings.edit')}
        confirmLabel={t('benchmark.settings.save')}
        busy={updateSettings.isPending}
        confirmDisabled={!parsedSettings}
        onConfirm={() => { if (parsedSettings) updateSettings.mutate({ id: benchmark.id, settings: parsedSettings }, { onSuccess: () => setSettings(null) }) }}
      >
        <div className="flex flex-col gap-4">
          {settings ? <RunSettingsFields draft={settings} onChange={setSettings} minRepetitions={minRepetitions} /> : null}
          <p className="text-sm text-ink-soft">{t('benchmark.settings.liveHint')}</p>
          {updateSettings.error ? <Banner>{updateSettings.error.message}</Banner> : null}
        </div>
      </ConfirmDialog>
      <header className={'flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-3 md:px-6'}>
        <MobileNavigationButton />
        <FlaskConical size={19} className="shrink-0 text-ink-faint" />
        {/* A floor on the title's width lets the actions wrap below it on a phone instead of crushing it. */}
        <div className="min-w-[12rem] flex-1">
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
        {state !== 'running' ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<RotateCcw size={14} />}
            busy={rerun.isPending}
            onClick={() => rerun.mutate(benchmark.id, { onSuccess: (created) => navigate(benchmarkPath(created.id)) })}
            title={t('benchmark.rerun.hint')}
          >
            {t('benchmark.rerun')}
          </Button>
        ) : null}
        {/* Nothing to show before a first run settles. */}
        {progress.done > 0 ? (
          <Button size="sm" variant="secondary" icon={<Share2 size={14} />} onClick={() => setSharing(true)} title={t('benchmark.share.hint')} data-benchmark-share-open>
            {t('benchmark.share.action')}
          </Button>
        ) : null}
        <Menu trigger={<IconButton label={t('benchmark.export')}><Download size={16} /></IconButton>}>
          <MenuItem icon={<FileText size={14} />} onSelect={() => { const file = benchmarkCsv(benchmark); downloadText(file.filename, file.content, 'text/csv') }}>
            {t('benchmark.export.csv')}
          </MenuItem>
          <MenuItem icon={<FileText size={14} />} onSelect={() => { const file = benchmarkJson(benchmark); downloadText(file.filename, file.content, 'application/json') }}>
            {t('benchmark.export.json')}
          </MenuItem>
        </Menu>
        <IconButton label={t('benchmark.delete')} onClick={() => setConfirming(true)}><Trash2 size={16} /></IconButton>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        {/* Full width: outputs are compared side by side, and every pixel of a wide screen is a wider page. */}
        <div className="flex flex-col gap-5">
          {error ? <Banner>{error.message}</Banner> : null}
          {/* Above everything: a run that asked is the one thing here that needs the viewer. */}
          {waitingRuns.length ? (
            <Banner tone="caution">
              <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-benchmark-waiting-banner>
                <span>{waitingRuns.length === 1
                  ? t('benchmark.waiting.one', { run: runName(waitingRuns[0]!.run) })
                  : t('benchmark.waiting.many', { count: waitingRuns.length })}</span>
                {waitingRuns.map(({ run }) => (
                  <Link key={run.id} to={conversationPath({ id: run.conversationId, projectId: null })} className="font-medium underline underline-offset-2 hover:no-underline">
                    {waitingRuns.length === 1 ? t('benchmark.waiting.answer') : runName(run)}
                  </Link>
                ))}
              </span>
            </Banner>
          ) : null}

          <section className="grid gap-x-8 gap-y-3 rounded-lg border border-line px-4 py-3 lg:grid-cols-[minmax(0,1fr)_auto]" data-benchmark-brief>
            <Prompt text={benchmark.prompt} />
            <dl className="flex flex-wrap content-start items-center gap-x-6 gap-y-1 text-xs text-ink-soft lg:max-w-md lg:justify-end">
              <Fact label={t('benchmark.form.repetitions')}>{benchmark.repetitions}</Fact>
              <Fact label={t('benchmark.form.concurrency')}>{benchmark.concurrency}</Fact>
              <Fact label={t('schedule.form.maxDuration')}>{benchmark.maxDurationMinutes}
                {/* One control for the three: they are changed together and saved in one request. */}
                <IconButton size="sm" label={t('benchmark.settings.edit')} onClick={() => {
                  updateSettings.reset()
                  setSettings(runSettingsDraft(benchmark))
                }}><Pencil size={13} /></IconButton></Fact>
              {benchmark.inputs.length ? (
                <Fact label={t('benchmark.form.inputs')}>
                  {benchmark.inputs.map((input) => `${input.filename} (${formatBytes(input.sizeBytes)})`).join(', ')}
                </Fact>
              ) : null}
            </dl>
            {benchmark.checkScript ? (
              <details className="col-span-full border-t border-line pt-2">
                <summary className="cursor-pointer text-xs text-ink-faint hover:text-ink">{t('benchmark.form.check')}</summary>
                <pre className="mt-2 overflow-x-auto rounded bg-sunken px-3 py-2 font-mono text-xs text-ink-soft">{benchmark.checkScript}</pre>
              </details>
            ) : null}
          </section>

          {blind.active ? (
            // Blind review shows outputs only: measures, costs and CLI names would give variants away.
            <section className="flex flex-col gap-4" data-benchmark-blind>
              <Banner tone="info">{t('benchmark.blind.active')}</Banner>
              <div>
                <Button size="sm" icon={<Eye size={14} />} onClick={() => blind.reveal()}>{t('benchmark.blind.reveal')}</Button>
              </div>
              <OutputsViewer benchmark={benchmark} order={blind.order} nameOf={nameOf} blind />
            </section>
          ) : (
          <Tabs label={t('benchmark.title')} value={shown} onChange={setTab} tabs={tabs} pinned={false}>
          {shown === 'outputs' ? <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" icon={<EyeOff size={14} />} onClick={() => blind.start()}>
                {t(blind.revealed ? 'benchmark.blind.restart' : 'benchmark.blind.start')}
              </Button>
              {blind.revealed ? <Button size="sm" variant="ghost" onClick={() => blind.reset()}>{t('benchmark.blind.forget')}</Button> : null}
              <span className="text-xs text-ink-faint">{t('benchmark.blind.hint')}</span>
            </div>
            <OutputsViewer benchmark={benchmark} order={blind.order} nameOf={nameOf} blind={false} />
          </div> : shown === 'chart' ? (
            <BenchmarkChart
              metrics={metricKeys}
              rows={blind.order.flatMap((variantId) => {
                const variant = benchmark.variants.find((entry) => entry.id === variantId)
                if (!variant) return []
                const name = nameOf(variantId)
                return [{
                  id: variantId,
                  text: name.text,
                  label: <span className="inline-flex min-w-0 items-center gap-1.5"><AgentIcon agent={variantAgent(variant)} size={13} /><span className="truncate">{name.label}</span></span>,
                  runs: benchmark.runs.filter((run) => run.variantId === variantId),
                }]
              })}
            />
          ) : shown === 'history' ? (
            <SeriesComparison series={series} current={benchmark.id} />
          ) : <>

          <p className="text-xs text-ink-faint">{t('benchmark.measures.explanation')}</p>
          <div className="overflow-x-auto rounded-lg border border-line" data-benchmark-results>
            <table className="w-full min-w-max border-collapse text-sm">
              <thead>
                <tr className="bg-surface-high text-left text-xs text-ink-faint">
                  <th scope="col" className="sticky left-0 z-10 bg-surface-high px-3 py-2 font-medium">{t('benchmark.table.run')}</th>
                  <th scope="col" className="px-3 py-2 font-medium">{t('benchmark.table.status')}</th>
                  {benchmark.checkScript ? <th scope="col" className="px-3 py-2 font-medium">{t('benchmark.table.check')}</th> : null}
                  {metricKeys.map((key) => (
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
                {blocks.map(({ variant, runs, medians, spreads, rate }) => (
                  <Fragment key={variant.id}>
                    <tr className="border-t border-line bg-sunken/60">
                      <th scope="rowgroup" colSpan={columnCount} className="sticky left-0 px-3 py-2 text-left font-medium">
                        <span className="inline-flex items-center gap-2">
                          <AgentIcon agent={variantAgent(variant)} size={14} />
                          <span className="text-ink-faint">{AGENT_LABELS[variantAgent(variant)]}</span>
                          <span>{nameOf(variant.id).label}</span>
                          {/* An alias such as “default” names no generation: show what the CLI announced. */}
                          {announcedModel(runs, variant) ? <span className="text-xs text-ink-faint">· {announcedModel(runs, variant)}</span> : null}
                          {modelsAccount(variant.config) ? <span className="text-xs text-ink-faint">· {t('benchmark.table.account')}</span> : null}
                          {cliVersion(runs) ? <span className="text-xs text-ink-faint">· v{cliVersion(runs)}</span> : null}
                          {rate && rate.checked > 0 ? (
                            <Badge tone={rate.passed === rate.checked ? 'positive' : rate.passed === 0 ? 'critical' : 'caution'}>
                              {t('benchmark.table.passRate', { passed: rate.passed, checked: rate.checked })}
                            </Badge>
                          ) : null}
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
                          <RunStatus run={run} />
                        </td>
                        {benchmark.checkScript ? (
                          <td className="px-3 py-1.5 whitespace-nowrap" data-benchmark-check={run.check ? (run.check.passed ? 'passed' : 'failed') : 'none'}>
                            {run.check ? (
                              <span
                                className={cx('inline-flex items-center gap-1', run.check.passed ? 'text-positive' : 'text-critical')}
                                title={checkSummary(run)}
                              >
                                {run.check.passed ? <Check size={13} /> : <X size={13} />}
                                {t(run.check.passed ? 'benchmark.check.passed' : run.check.timedOut ? 'benchmark.check.timedOut' : 'benchmark.check.failed', { code: run.check.exitCode ?? '?' })}
                              </span>
                            ) : <span className="text-ink-faint">—</span>}
                          </td>
                        ) : null}
                        {metricKeys.map((key) => (
                          <td key={key} className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap" title={key === 'toolCalls' ? toolBreakdown(run) : undefined}>
                            {formatMetric(key, metricValue(run, key), lang)}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {runs.length > 1 ? (
                      <tr className="border-t border-line/60 text-ink-soft" data-benchmark-median>
                        <td className="sticky left-0 bg-surface px-3 py-1.5 text-xs font-medium whitespace-nowrap">{t('benchmark.table.median')}</td>
                        <td />
                        {benchmark.checkScript ? <td /> : null}
                        {metricKeys.map((key) => {
                          const range = spreads[key]
                          return (
                            <td key={key} className="px-3 py-1.5 text-right text-xs tabular-nums whitespace-nowrap">
                              <span className="font-medium">{formatMetric(key, medians[key] ?? null, lang)}</span>
                              {range ? (
                                <span className="block text-[0.6875rem] text-ink-faint" title={t('benchmark.table.spread')}>
                                  {formatMetric(key, range.min, lang)} – {formatMetric(key, range.max, lang)}
                                </span>
                              ) : null}
                            </td>
                          )
                        })}
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-ink-faint">{t('benchmark.table.legend')}</p>
          </>}
          </Tabs>
          )}
        </div>
      </div>

      {sharing ? <Suspense fallback={null}><BenchmarkShareDialog benchmark={benchmark} onClose={() => setSharing(false)} /></Suspense> : null}

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

/**
 * The prompt, three lines of it: enough to recognise the task, short enough to leave the screen
 * to the results. The toggle only exists when something is actually cut.
 */
function Prompt({ text }: { text: string }) {
  const t = useTranslate()
  const ref = useRef<HTMLParagraphElement>(null)
  const [open, setOpen] = useState(false)
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || open) return
    const measure = () => setClipped(element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text, open])
  return (
    <div className="min-w-0">
      <h2 className="text-xs text-ink-faint">{t('benchmark.form.prompt')}</h2>
      <p ref={ref} className={cx('mt-1 max-w-[90ch] text-sm whitespace-pre-wrap text-ink-soft', open ? null : 'line-clamp-3')}>{text}</p>
      {clipped || open ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="mt-1 inline-flex items-center gap-1 text-xs text-accent hover:underline">
          {t(open ? 'benchmark.prompt.less' : 'benchmark.prompt.more')}
          <ChevronDown size={12} className={cx('transition-transform', open && 'rotate-180')} />
        </button>
      ) : null}
    </div>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="flex items-center gap-1.5 font-medium text-ink">{children}</dd>
    </div>
  )
}

/** Model reported at session start when it adds to the configured value and to the label. */
function announcedModel(runs: BenchmarkRunDto[], variant: BenchmarkVariant): string | null {
  const model = runs.map((run) => run.metrics?.model ?? null).find((value) => value !== null) ?? null
  return model && model !== variant.config.model && !variant.label.includes(model) ? model : null
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

interface VariantBlock {
  variant: BenchmarkVariant
  runs: BenchmarkRunDto[]
  medians: Partial<Record<MetricKey, number | null>>
  spreads: Partial<Record<MetricKey, { min: number; max: number } | null>>
  rate: { passed: number; checked: number } | null
}

function variantBlocks(benchmark: BenchmarkDto, sort: Sort | null): VariantBlock[] {
  const blocks = benchmark.variants.map((variant): VariantBlock => {
    const runs = benchmark.runs.filter((run) => run.variantId === variant.id).sort((a, b) => a.repetition - b.repetition)
    const medians: VariantBlock['medians'] = {}
    const spreads: VariantBlock['spreads'] = {}
    for (const key of METRIC_KEYS) {
      const values = runs.map((run) => metricValue(run, key))
      medians[key] = median(values)
      spreads[key] = spread(values)
    }
    return { variant, runs, medians, spreads, rate: passRate(benchmark, runs) }
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
