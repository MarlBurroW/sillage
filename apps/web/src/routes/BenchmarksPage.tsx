import { FlaskConical, Plus, Search, Star } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { benchmarkPath, variantAgent, type BenchmarkDto, type BenchmarkRunDto } from '@sillage/protocol'
import { AgentIcon } from '../components/AgentIcon'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { Badge, Banner, Button, EmptyState, cx } from '../components/ui'
import {
  BENCHMARK_STATE_LABELS,
  RUN_STATUS_LABELS,
  benchmarkProgress,
  benchmarkState,
  formatMetric,
  useBenchmarks,
  variantMedian,
  type BenchmarkState,
} from '../lib/benchmarks'
import { relativeDate } from '../lib/dates'
import { locale, useTranslate } from '../lib/i18n'

export const BENCHMARK_STATE_TONES: Record<BenchmarkState, 'neutral' | 'accent' | 'positive' | 'critical'> = {
  running: 'accent',
  done: 'positive',
  failed: 'critical',
  cancelled: 'neutral',
}

/** One square per run: the same colours as the run dots of the detail page. */
export const RUN_TONES: Record<BenchmarkRunDto['status'], string> = {
  pending: 'bg-line-strong',
  running: 'bg-accent animate-pulse',
  checking: 'bg-accent animate-pulse',
  succeeded: 'bg-positive',
  failed: 'bg-critical',
  timed_out: 'bg-caution',
  cancelled: 'bg-line-strong',
}

/** Past this many variants a row stops being a summary: the rest is one click away. */
const MAX_LISTED_VARIANTS = 5

/** The search field is noise until the list no longer fits one screen. */
const SEARCH_FROM = 7

/** All the account's benchmarks, newest first. Each row already answers “who was fastest”. */
export function BenchmarksPage() {
  const t = useTranslate()
  const { data: benchmarks, isPending, isError } = useBenchmarks()
  const [query, setQuery] = useState('')
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return benchmarks ?? []
    return (benchmarks ?? []).filter((benchmark) =>
      [benchmark.name, benchmark.prompt, ...benchmark.variants.map((variant) => variant.label)].some((text) => text.toLowerCase().includes(needle)))
  }, [benchmarks, query])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={'flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-3 md:px-6'}>
        <MobileNavigationButton />
        <FlaskConical size={19} className="shrink-0 text-ink-faint" />
        <h1 className="text-base font-semibold">{t('benchmark.title')}</h1>
        {benchmarks?.length ? <Badge>{benchmarks.length}</Badge> : null}
        <div className="ml-auto flex items-center gap-2">
          {(benchmarks?.length ?? 0) >= SEARCH_FROM ? (
            <label className="flex h-11 items-center gap-2 rounded-md border border-line bg-sunken px-2.5 focus-within:border-accent max-sm:hidden md:h-9">
              <Search size={14} className="shrink-0 text-ink-faint" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('benchmark.list.search')}
                aria-label={t('benchmark.list.search')}
                className="w-44 bg-transparent text-sm outline-none placeholder:text-ink-faint"
              />
            </label>
          ) : null}
          <Link to="/benchmarks/new">
            <Button size="sm" icon={<Plus size={15} />}>{t('benchmark.new')}</Button>
          </Link>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-4">
          {isError ? <Banner>{t('benchmark.loadError')}</Banner> : null}
          {isPending ? (
            <p role="status" className="text-sm text-ink-faint">{t('schedule.loading')}</p>
          ) : !benchmarks?.length ? (
            <EmptyState
              icon={<FlaskConical size={22} />}
              title={t('benchmark.empty')}
              description={t('benchmark.emptyHint')}
              action={<Link to="/benchmarks/new"><Button size="sm" icon={<Plus size={15} />}>{t('benchmark.new')}</Button></Link>}
            />
          ) : <>
            <p className="max-w-3xl text-sm text-ink-soft">{t('benchmark.description')}</p>
            {shown.length === 0 ? <p className="py-10 text-center text-sm text-ink-faint">{t('benchmark.list.noMatch')}</p> : (
              <ul className="flex flex-col gap-2.5">
                {shown.map((benchmark) => <li key={benchmark.id}><BenchmarkRow benchmark={benchmark} /></li>)}
              </ul>
            )}
          </>}
        </div>
      </div>
    </div>
  )
}

function BenchmarkRow({ benchmark }: { benchmark: BenchmarkDto }) {
  const t = useTranslate()
  const lang = locale()
  const state = benchmarkState(benchmark)
  const progress = benchmarkProgress(benchmark)
  const lines = benchmark.variants.map((variant) => ({
    variant,
    runs: benchmark.runs.filter((run) => run.variantId === variant.id).sort((a, b) => a.repetition - b.repetition),
    duration: variantMedian(benchmark, variant.id, 'durationMs'),
    rating: variantMedian(benchmark, variant.id, 'rating'),
  }))
  const durations = lines.flatMap((line) => (line.duration === null ? [] : [line.duration]))
  const slowest = Math.max(0, ...durations)
  // Naming a fastest variant takes at least two that finished.
  const fastest = durations.length > 1 ? Math.min(...durations) : null
  const listed = lines.slice(0, MAX_LISTED_VARIANTS)

  return (
    <Link
      to={benchmarkPath(benchmark.id)}
      className="surface grid min-w-0 gap-x-8 gap-y-3 rounded-lg border border-line p-4 transition-colors hover:border-line-strong lg:grid-cols-[minmax(0,4fr)_minmax(0,5fr)]"
      data-benchmark={benchmark.name}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 font-medium break-words">{benchmark.name}</h2>
          {benchmark.seriesId ? <Badge>{t('benchmark.rerunBadge')}</Badge> : null}
          <Badge tone={BENCHMARK_STATE_TONES[state]}>
            {t(BENCHMARK_STATE_LABELS[state])}{state === 'running' ? ` · ${progress.done}/${progress.total}` : ''}
          </Badge>
        </div>
        <p className="line-clamp-2 text-sm text-ink-soft">{benchmark.prompt}</p>
        <p className="mt-auto pt-1 text-xs text-ink-faint">
          {relativeDate(benchmark.createdAt)}
          {benchmark.repetitions > 1 ? ` · ${t('benchmark.list.repetitions', { count: benchmark.repetitions })}` : ''}
          {benchmark.checkScript ? ` · ${t('benchmark.list.checked')}` : ''}
        </p>
      </div>

      {/* A scoreboard in small: one line per variant, its runs as squares, its median time as a bar. */}
      <ul className="flex min-w-0 flex-col justify-center gap-1.5" aria-label={t('benchmark.form.variants')}>
        {listed.map(({ variant, runs, duration, rating }) => (
          <li key={variant.id} className="grid grid-cols-[minmax(0,11rem)_auto_minmax(2rem,1fr)_auto] sm:grid-cols-[minmax(0,11rem)_auto_minmax(2rem,1fr)_7.5rem] items-center gap-x-3 text-xs" data-benchmark-line>
            <span className="flex min-w-0 items-center gap-1.5">
              <AgentIcon agent={variantAgent(variant)} size={14} />
              <span className={cx('truncate', duration !== null && duration === fastest ? 'font-medium text-ink' : 'text-ink-soft')}>{variant.label}</span>
            </span>
            <span className="flex items-center gap-0.5" role="img" aria-label={runs.map((run) => t(RUN_STATUS_LABELS[run.status])).join(', ')}>
              {runs.map((run) => <span key={run.id} title={t(RUN_STATUS_LABELS[run.status])} className={cx('size-2', RUN_TONES[run.status])} />)}
            </span>
            <span className="flex h-1.5 min-w-0 items-center bg-surface-high" aria-hidden>
              {duration !== null && slowest > 0 ? (
                <span className={cx('h-full', duration === fastest ? 'bg-accent' : 'bg-line-strong')} style={{ width: `${Math.max(3, (duration / slowest) * 100)}%` }} />
              ) : null}
            </span>
            <span className="flex items-center justify-end gap-1.5 text-right whitespace-nowrap tabular-nums">
              {rating !== null ? <span className="inline-flex items-center gap-0.5 text-ink-faint"><Star size={10} className="fill-current" />{rating.toLocaleString(lang, { maximumFractionDigits: 1 })}</span> : null}
              <span className={duration !== null && duration === fastest ? 'font-medium text-ink' : 'text-ink-soft'}>{formatMetric('durationMs', duration, lang)}</span>
            </span>
          </li>
        ))}
        {lines.length > listed.length ? <li className="text-xs text-ink-faint">{t('benchmark.list.more', { count: lines.length - listed.length })}</li> : null}
      </ul>
    </Link>
  )
}
