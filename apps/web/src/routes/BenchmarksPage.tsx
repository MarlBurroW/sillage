import { FlaskConical, Plus } from 'lucide-react'
import { Link } from 'react-router-dom'
import { benchmarkPath, variantAgent } from '@sillage/protocol'
import { AgentIcon } from '../components/AgentIcon'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { Badge, Banner, Button, EmptyState, cx } from '../components/ui'
import { BENCHMARK_STATE_LABELS, benchmarkProgress, benchmarkState, useBenchmarks, type BenchmarkState } from '../lib/benchmarks'
import { relativeDate } from '../lib/dates'
import { useTranslate } from '../lib/i18n'
import { useSidebarHidden } from '../lib/sidebar'

export const BENCHMARK_STATE_TONES: Record<BenchmarkState, 'neutral' | 'accent' | 'positive' | 'critical'> = {
  running: 'accent',
  done: 'positive',
  failed: 'critical',
  cancelled: 'neutral',
}

/** All the account's benchmarks, newest first. Each row is a door to its measurements. */
export function BenchmarksPage() {
  const t = useTranslate()
  const sidebarHidden = useSidebarHidden()
  const { data: benchmarks, isPending, isError } = useBenchmarks()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={cx('flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-3 md:px-6', sidebarHidden && 'md:pl-14')}>
        <MobileNavigationButton />
        <FlaskConical size={19} className="shrink-0 text-ink-faint" />
        <h1 className="text-base font-semibold">{t('benchmark.title')}</h1>
        {benchmarks?.length ? <Badge>{benchmarks.length}</Badge> : null}
        <div className="ml-auto">
          <Link to="/benchmarks/new">
            <Button size="sm" icon={<Plus size={15} />}>{t('benchmark.new')}</Button>
          </Link>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <p className="text-sm text-ink-soft">{t('benchmark.description')}</p>
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
          ) : (
            <ul className="flex flex-col gap-2">
              {benchmarks.map((benchmark) => {
                const state = benchmarkState(benchmark)
                const progress = benchmarkProgress(benchmark)
                const agents = [...new Set(benchmark.variants.map(variantAgent))]
                return (
                  <li key={benchmark.id}>
                    <Link
                      to={benchmarkPath(benchmark.id)}
                      className="surface flex min-w-0 flex-col gap-2 rounded-lg border border-line p-4 transition-colors hover:border-line-strong"
                      data-benchmark={benchmark.name}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="flex items-center gap-1">{agents.map((agent) => <AgentIcon key={agent} agent={agent} size={16} />)}</span>
                        <h2 className="min-w-0 flex-1 font-medium break-words">{benchmark.name}</h2>
                        <Badge tone={BENCHMARK_STATE_TONES[state]}>{t(BENCHMARK_STATE_LABELS[state])}</Badge>
                      </div>
                      <p className="line-clamp-2 text-xs text-ink-soft">{benchmark.prompt}</p>
                      <p className="text-xs text-ink-faint">
                        {t('benchmark.summary', { variants: benchmark.variants.length, done: progress.done, total: progress.total })} · {relativeDate(benchmark.createdAt)}
                      </p>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
