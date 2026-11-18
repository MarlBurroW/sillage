import { Pencil, ArrowDown, ArrowUp, Check, ChevronDown, CopyPlus, Download, ExternalLink, Eye, EyeOff, FileText, FlaskConical, ListPlus, MonitorPlay, RotateCcw, Share2, Square, Trash2, X } from 'lucide-react'
import { Fragment, Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useNavigationType, useParams, useSearchParams } from 'react-router-dom'
import {
  MAX_BENCHMARK_COMPARISON_VARIANTS,
  MAX_BENCHMARK_TOTAL_VARIANTS,
  benchmarkPath,
  eligibleRuns,
  startedRepetitions,
  conversationPath,
  variantAgent,
  variantMeasure,
  type BenchmarkDto,
  type BenchmarkRunDto,
  type BenchmarkVariantDto,
} from '@sillage/protocol'
import { AGENT_LABELS, AgentIcon } from '../components/AgentIcon'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { RunSettingsFields, parseRunSettings, runSettingsDraft, type RunSettingsDraft } from '../components/benchmark/RunSettingsFields'
import { BenchmarkChart } from '../components/benchmark/BenchmarkChart'
import { ComparisonPicker } from '../components/benchmark/ComparisonPicker'
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
  metricValue,
  openSlides,
  passRate,
  readShareOptions,
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

// Only people who share, continue or compare pay for these: they stay out of the page's chunk.
const BenchmarkShareDialog = lazy(() => import('../components/benchmark/BenchmarkShareDialog'))
const LineupDialog = lazy(() => import('../components/benchmark/LineupDialog'))
const ComparisonView = lazy(() => import('../components/benchmark/ComparisonView'))

type Tab = 'measures' | 'compare' | 'chart' | 'outputs' | 'history'
const TABS: Tab[] = ['measures', 'compare', 'chart', 'outputs', 'history']

interface Sort {
  key: MetricKey
  direction: 'asc' | 'desc'
}

/** The two parameters this page keeps in the address, as one comparable value. */
const addressKey = (tab: string | null, vs: string | null) => `${tab ?? ''}|${vs ?? ''}`

/** Variants picked for comparison, from the address: known ids only, once each, the baseline first. */
function parseSelection(raw: string | null, variantIds: string[]): string[] {
  const ids: string[] = []
  for (const id of (raw ?? '').split(',')) {
    if (variantIds.includes(id) && !ids.includes(id) && ids.length < MAX_BENCHMARK_COMPARISON_VARIANTS) ids.push(id)
  }
  return ids
}

/**
 * The benchmark of the address. Keyed by id: sorting, dialogs and the blind review belong to one
 * benchmark, and the router reuses this element when another one is opened from the column.
 */
export function BenchmarkPage() {
  const { id } = useParams()
  return <BenchmarkView key={id} id={id ?? ''} />
}

/**
 * A benchmark's measurements: one block per variant, one row per run, a median row when a variant
 * ran several times. Sorting reorders variants by their median so the question “which is fastest”
 * has a one-click answer; rows inside a variant stay in repetition order. The open tab and the
 * variants being compared live in the address, so a comparison can be reopened or sent as a link.
 */
function BenchmarkView({ id }: { id: string }) {
  const t = useTranslate()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { data: benchmarks, isPending, isError } = useBenchmarks()
  const cancel = useCancelBenchmark()
  const updateSettings = useUpdateBenchmarkSettings()
  // Null while the dialog is closed: the draft is taken from the benchmark each time it opens.
  const [settings, setSettings] = useState<RunSettingsDraft | null>(null)
  const remove = useDeleteBenchmark()
  const [confirming, setConfirming] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [lineup, setLineup] = useState<'edit' | 'add' | null>(null)
  const [sort, setSort] = useState<Sort | null>(null)
  // The open tab and the compared variants, read from the address and written back to it. Held
  // here too because the router applies a new address after the click: a ticked box would
  // flicker back to empty until then. `pending` lists the addresses this page asked for and has
  // not seen land yet, oldest first: seeing one land drops it and those before it. Any other
  // address (the column, Back, Forward) is followed and empties the list, so a navigation that
  // overtakes the page's own write can never leave the page ignoring the address.
  const [view, setView] = useState(() => ({ tab: params.get('tab'), vs: params.get('vs') }))
  const pending = useRef<string[]>([])
  const tabParam = params.get('tab')
  const vsParam = params.get('vs')
  const navigationType = useNavigationType()
  // Read by the effect below without making every view change re-run it; declared first, so it is
  // current when that effect runs in the same commit.
  const viewRef = useRef(view)
  useEffect(() => { viewRef.current = view }, [view])
  useEffect(() => {
    const landed = pending.current.indexOf(addressKey(tabParam, vsParam))
    if (landed !== -1) {
      pending.current = pending.current.slice(landed + 1)
      return
    }
    pending.current = []
    // Tapping the open benchmark in the column (also how the phone drawer closes) pushes its bare
    // address: that tap means "this benchmark", not "back to Measures". Keep what is open and put
    // it back in the address. Back and Forward (POP) still follow the address, whatever it holds.
    const current = viewRef.current
    if (navigationType === 'PUSH' && tabParam === null && vsParam === null && (current.tab !== null || current.vs !== null)) {
      pending.current = [addressKey(current.tab, current.vs)]
      setParams((address) => {
        const next = new URLSearchParams(address)
        if (current.tab) next.set('tab', current.tab)
        if (current.vs) next.set('vs', current.vs)
        return next
      }, { replace: true })
      return
    }
    setView((existing) => (existing.tab === tabParam && existing.vs === vsParam ? existing : { tab: tabParam, vs: vsParam }))
  }, [tabParam, vsParam, navigationType, setParams])
  const benchmark = benchmarks?.find((entry) => entry.id === id)
  const rerun = useRerunBenchmark()
  const variantIds = useMemo(() => benchmark?.variants.map((variant) => variant.id) ?? [], [benchmark])
  const blind = useBlindReview(id, variantIds)
  const series = useMemo(() => (benchmark && benchmarks ? benchmarkSeries(benchmarks, benchmark) : []), [benchmark, benchmarks])
  const waitingRuns = useWaitingRuns(benchmarks).filter((entry) => entry.benchmark.id === id)

  const blocks = useMemo(() => (benchmark ? variantBlocks(benchmark, sort) : []), [benchmark, sort])
  const metricKeys = useMemo(() => (benchmark ? visibleMetricKeys(benchmark) : METRIC_KEYS), [benchmark])
  const selection = useMemo(() => parseSelection(view.vs, variantIds), [view.vs, variantIds])
  // With two variants nothing is picked (both are compared): a leftover address must not mute a bar.
  const emphasis = useMemo(() => new Set(variantIds.length > 2 ? selection : []), [selection, variantIds])
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
  const lang = locale()
  const full = benchmark.variants.length >= MAX_BENCHMARK_TOTAL_VARIANTS
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

  // With two variants there is nothing to pick: comparing means both, and the address only says
  // which side is the baseline. So it counts as no selection: no count, no selection line.
  const pickable = benchmark.variants.length > 2
  const compared = pickable ? selection : selection.length === 2 ? selection : variantIds
  const picked = pickable ? selection : []
  const tabs: { value: Tab; label: string }[] = [
    { value: 'measures', label: t('benchmark.tab.measures') },
    ...(benchmark.variants.length >= 2
      ? [{ value: 'compare' as const, label: picked.length > 0 ? t('benchmark.tab.compareCount', { count: picked.length }) : t('benchmark.tab.compare') }]
      : []),
    { value: 'chart', label: t('benchmark.tab.chart') },
    { value: 'outputs', label: t('benchmark.tab.outputs') },
    // History only exists once the benchmark has been rerun.
    ...(series.length > 1 ? [{ value: 'history' as const, label: t('benchmark.tab.history', { count: series.length }) }] : []),
  ]
  const requested = TABS.find((value) => value === view.tab) ?? 'measures'
  const shown: Tab = tabs.some((entry) => entry.value === requested) ? requested : 'measures'

  /** Changes the tab or the compared variants, and the address with them without stacking history entries. */
  const navigateTo = (change: { tab?: Tab; vs?: string[] }) => {
    const next = {
      tab: change.tab === undefined ? view.tab : change.tab === 'measures' ? null : change.tab,
      vs: change.vs === undefined ? view.vs : change.vs.length > 0 ? change.vs.join(',') : null,
    }
    setView(next)
    // An address equal to the current one never lands as a change: nothing to wait for.
    const target = addressKey(next.tab, next.vs)
    if (target !== addressKey(tabParam, vsParam)) pending.current = [...pending.current, target]
    setParams((current) => {
      const address = new URLSearchParams(current)
      for (const [key, value] of Object.entries(next)) {
        if (value) address.set(key, value)
        else address.delete(key)
      }
      return address
    }, { replace: true })
  }
  const toggleCompared = (variantId: string) => navigateTo({
    vs: selection.includes(variantId)
      ? selection.filter((entry) => entry !== variantId)
      : selection.length >= MAX_BENCHMARK_COMPARISON_VARIANTS ? selection : [...selection, variantId],
  })

  const toggleSort = (key: MetricKey) =>
    setSort((current) => (current?.key === key ? (current.direction === 'asc' ? { key, direction: 'desc' } : null) : { key, direction: 'asc' }))
  const openSettings = () => {
    updateSettings.reset()
    setSettings(runSettingsDraft(benchmark))
  }

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
          <Button
            size="sm"
            variant="secondary"
            icon={<MonitorPlay size={14} />}
            onClick={() => openSlides(benchmark.id, readShareOptions(benchmark, lang))}
            title={t('benchmark.page.presentHint')}
            aria-label={t('benchmark.page.present')}
            data-benchmark-present
          >
            {/* An icon on a phone: the header already wraps on two lines there. */}
            <span className="max-sm:sr-only">{t('benchmark.page.present')}</span>
          </Button>
        ) : null}
        {progress.done > 0 ? (
          <Button size="sm" variant="secondary" icon={<Share2 size={14} />} onClick={() => setSharing(true)} title={t('benchmark.share.hint')} data-benchmark-share-open>
            {t('benchmark.share.action')}
          </Button>
        ) : null}
        <IconButton
          label={full ? t('benchmark.page.variantsFull', { max: MAX_BENCHMARK_TOTAL_VARIANTS }) : t('benchmark.page.addVariant')}
          disabled={full}
          onClick={() => setLineup('add')}
          data-benchmark-add-variant
        >
          <ListPlus size={16} />
        </IconButton>
        <IconButton label={t('benchmark.page.newFrom')} onClick={() => navigate(`/benchmarks/new?from=${encodeURIComponent(benchmark.id)}`)} data-benchmark-new-from>
          <CopyPlus size={16} />
        </IconButton>
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
              <Fact label={t('benchmark.page.variants')}>{benchmark.variants.length}
                {/* Continuing a benchmark: order, names, new models and removals in one dialog. */}
                <IconButton size="sm" label={t('benchmark.page.editLineup')} onClick={() => setLineup('edit')} data-benchmark-lineup-edit><Pencil size={13} /></IconButton></Fact>
              <Fact label={t('benchmark.form.repetitions')}>{benchmark.repetitions}</Fact>
              <Fact label={t('benchmark.form.concurrency')}>{benchmark.concurrency}</Fact>
              <Fact label={t('schedule.form.maxDuration')}>{benchmark.maxDurationMinutes}
                {/* One control for the three: they are changed together and saved in one request. */}
                <IconButton size="sm" label={t('benchmark.settings.edit')} onClick={openSettings}><Pencil size={13} /></IconButton></Fact>
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
          <Tabs label={t('benchmark.title')} value={shown} onChange={(tab) => navigateTo({ tab })} tabs={tabs} pinned={false}>
          {shown === 'outputs' ? <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" icon={<EyeOff size={14} />} onClick={() => blind.start()}>
                {t(blind.revealed ? 'benchmark.blind.restart' : 'benchmark.blind.start')}
              </Button>
              {blind.revealed ? <Button size="sm" variant="ghost" onClick={() => blind.reset()}>{t('benchmark.blind.forget')}</Button> : null}
              <span className="text-xs text-ink-faint">{t('benchmark.blind.hint')}</span>
            </div>
            <OutputsViewer benchmark={benchmark} order={blind.order} nameOf={nameOf} blind={false} />
          </div> : shown === 'compare' ? (
            <div className="flex flex-col gap-5">
              {/* Two variants leave nothing to pick, but their saved comparisons still live here. */}
              <ComparisonPicker benchmark={benchmark} selected={compared} onChange={(vs) => navigateTo({ vs })} nameOf={nameOf} pickable={pickable} />
              {compared.length >= 2 ? (
                <Suspense fallback={<p role="status" className="text-sm text-ink-faint">{t('schedule.loading')}</p>}>
                  <ComparisonView
                    benchmark={benchmark}
                    ids={compared}
                    nameOf={nameOf}
                    metricKeys={metricKeys}
                    onBaseline={(variantId) => navigateTo({ vs: [variantId, ...compared.filter((entry) => entry !== variantId)] })}
                    onRemove={pickable ? (variantId) => navigateTo({ vs: compared.filter((entry) => entry !== variantId) }) : undefined}
                    onRunSettings={openSettings}
                  />
                </Suspense>
              ) : (
                <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-ink-faint" data-compare-empty>{t('benchmark.compare.empty')}</p>
              )}
            </div>
          ) : shown === 'chart' ? (
            <BenchmarkChart
              metrics={metricKeys}
              emphasis={emphasis}
              checkScript={benchmark.checkScript}
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
          {picked.length > 0 ? (
            // Inline rather than sticky: this page's tabs were unpinned so nothing covers the table.
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-compare-selection>
              <span className="text-ink-soft">{t(picked.length === 1 ? 'benchmark.compare.selected.one' : 'benchmark.compare.selected', { count: picked.length })}</span>
              <Button size="sm" variant="ghost" disabled={picked.length < 2} onClick={() => navigateTo({ tab: 'compare' })}>{t('benchmark.compare.open')}</Button>
              <Button size="sm" variant="ghost" onClick={() => navigateTo({ vs: [] })}>{t('benchmark.compare.clear')}</Button>
            </div>
          ) : null}
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
                {blocks.map(({ variant, runs, medians, spreads, rate, pool }) => {
                  const checked = selection.includes(variant.id)
                  return (
                  <Fragment key={variant.id}>
                    <tr className="border-t border-line bg-sunken/60" data-benchmark-group={variant.id}>
                      <th scope="rowgroup" colSpan={columnCount} className="sticky left-0 px-3 py-2 text-left font-medium">
                        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          {benchmark.variants.length > 2 ? (
                            <input
                              type="checkbox"
                              className="size-4 accent-accent"
                              checked={checked}
                              disabled={!checked && selection.length >= MAX_BENCHMARK_COMPARISON_VARIANTS}
                              aria-label={t('benchmark.compare.toggle', { name: nameOf(variant.id).text })}
                              onChange={() => toggleCompared(variant.id)}
                              data-compare-check={variant.id}
                            />
                          ) : null}
                          <AgentIcon agent={variantAgent(variant)} size={14} />
                          <span className="text-ink-faint">{AGENT_LABELS[variantAgent(variant)]}</span>
                          <span>{nameOf(variant.id).label}</span>
                          {/* The exact model and effort behind a short name, as the CLI announced them. */}
                          {variant.technicalLabel !== variant.label ? <span className="text-xs font-normal text-ink-faint">· {variant.technicalLabel}</span> : null}
                          {modelsAccount(variant.config) ? <span className="text-xs font-normal text-ink-faint">· {t('benchmark.table.account')}</span> : null}
                          {cliVersion(runs) ? <span className="text-xs font-normal text-ink-faint">· v{cliVersion(runs)}</span> : null}
                          {variant.addedAt ? (
                            <span className="text-xs font-normal text-ink-faint" title={t('benchmark.page.addedHint')}>· {t('benchmark.page.added', { date: new Date(variant.addedAt).toLocaleDateString(lang, { dateStyle: 'medium' }) })}</span>
                          ) : null}
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
                      <tr className="border-t border-line/60 text-ink-soft" data-benchmark-median data-median-pool={pool ?? undefined}>
                        <td className="sticky left-0 bg-surface px-3 py-1.5 text-xs font-medium whitespace-nowrap">
                          {t('benchmark.table.median')}
                          {pool ? (
                            <span className={cx('block text-[0.6875rem] font-normal', pool === 'failed' ? 'text-caution' : 'text-ink-faint')}>
                              {t(pool === 'failed' ? 'benchmark.compare.failedOnly' : 'benchmark.table.medianSucceeded')}
                            </span>
                          ) : null}
                        </td>
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
                  )
                })}
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
      {lineup ? <Suspense fallback={null}><LineupDialog benchmark={benchmark} intent={lineup} onClose={() => setLineup(null)} /></Suspense> : null}

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
function variantBlocks(benchmark: BenchmarkDto, sort: Sort | null): VariantBlock[] {
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
