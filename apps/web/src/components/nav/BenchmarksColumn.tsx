import { benchmarkPath } from '@sillage/protocol'
import { Plus, RotateCcw } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { BENCHMARK_STATE_LABELS, benchmarkProgress, benchmarkState, useBenchmarks, type BenchmarkState } from '../../lib/benchmarks'
import { useTranslate } from '../../lib/i18n'
import { Tooltip } from '../ui/Tooltip'
import { cx } from '../ui'
import { ColumnHead, ColumnHeading, useNavChrome } from './chrome'

const STATE_DOTS: Record<BenchmarkState, string> = {
  running: 'bg-accent animate-pulse',
  done: 'bg-positive',
  failed: 'bg-critical',
  cancelled: 'bg-line-strong',
}

/**
 * Benchmarks belong to nobody's project. Their runs do not appear here, nor among discussions:
 * the benchmark page carries their measurements and links.
 */
export function BenchmarksColumn() {
  const t = useTranslate()
  const { onNavigate } = useNavChrome()
  const { data: benchmarks } = useBenchmarks()
  const list = benchmarks ?? []

  return (
    <>
      <ColumnHead title={t('benchmark.title')} actions={
        <Tooltip label={t('benchmark.new')} side="bottom">
          <NavLink to="/benchmarks/new" onClick={onNavigate} aria-label={t('benchmark.new')} className="sidebar-add-session"><Plus size={16} /></NavLink>
        </Tooltip>
      } />
      <ColumnHeading label={t('benchmark.title')} count={list.length} />
      <div className="nav-column-scroll" data-sidebar-benchmarks>
        <ul className="flex flex-col gap-px">
          {list.map((benchmark) => {
            const state = benchmarkState(benchmark)
            const progress = benchmarkProgress(benchmark)
            return (
              <li key={benchmark.id}>
                <NavLink
                  to={benchmarkPath(benchmark.id)}
                  onClick={onNavigate}
                  title={`${benchmark.name}${benchmark.seriesId ? ` · ${t('benchmark.rerunBadge')}` : ''} · ${t(BENCHMARK_STATE_LABELS[state])}`}
                  className={({ isActive }) => cx('sidebar-session nav-benchmark', isActive && 'sidebar-current')}
                >
                  <span aria-hidden className={cx('size-1.5 shrink-0 rounded-full', STATE_DOTS[state])} />
                  <span className="sr-only">{t(BENCHMARK_STATE_LABELS[state])}</span>
                  <span className="sidebar-session-title flex-1">{benchmark.name}</span>
                  {/* Reruns keep their original's name: the icon tells them apart. */}
                  {benchmark.seriesId ? <RotateCcw size={11} className="shrink-0 text-ink-faint" aria-label={t('benchmark.rerunBadge')} /> : null}
                  <span className="shrink-0 text-[0.6875rem] tabular-nums text-ink-faint">{progress.done}/{progress.total}</span>
                </NavLink>
              </li>
            )
          })}
          {!list.length ? <li className="px-3 py-3 text-xs text-ink-faint">{t('benchmark.empty')}</li> : null}
        </ul>
      </div>
    </>
  )
}
