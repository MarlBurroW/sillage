import { benchmarkPath } from '@sillage/protocol'
import { Plus, RotateCcw, Search, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { BENCHMARK_STATE_LABELS, benchmarkProgress, benchmarkState, useBenchmarks, type BenchmarkState } from '../../lib/benchmarks'
import { useTranslate } from '../../lib/i18n'
import { Tooltip } from '../ui/Tooltip'
import { IconButton, cx } from '../ui'
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
  const [filterOpen, setFilterOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const filterInput = useRef<HTMLInputElement>(null)
  // A benchmark is remembered by what it asked or whom it compared as often as by its name.
  const query = filter.trim().toLocaleLowerCase()
  const matching = list.filter((benchmark) => !query
    || [benchmark.name, benchmark.prompt, ...benchmark.variants.map((variant) => variant.label)].some((text) => text.toLocaleLowerCase().includes(query)))

  return (
    <>
      <ColumnHead title={t('benchmark.title')} actions={
        <Tooltip label={t('benchmark.new')} side="bottom">
          <NavLink to="/benchmarks/new" onClick={onNavigate} aria-label={t('benchmark.new')} className="sidebar-add-session"><Plus size={16} /></NavLink>
        </Tooltip>
      } />
      <ColumnHeading label={t('benchmark.title')} count={list.length}>
        <IconButton label={t('benchmark.filter')} size="sm" aria-expanded={filterOpen} onClick={() => { setFilterOpen((value) => !value); setFilter(''); if (!filterOpen) requestAnimationFrame(() => filterInput.current?.focus()) }}><Search size={14} /></IconButton>
      </ColumnHeading>
      {filterOpen && <div className="sidebar-session-filter"><Search size={14} /><input ref={filterInput} type="search" value={filter} onChange={(event) => setFilter(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setFilterOpen(false); setFilter('') } }} aria-label={t('benchmark.search')} placeholder={t('benchmark.search')} /><IconButton label={t('shell.sessions.clear')} size="sm" onClick={() => { setFilter(''); filterInput.current?.focus() }}><X size={13} /></IconButton></div>}
      <div className="nav-column-scroll" data-sidebar-benchmarks>
        <ul className="flex flex-col gap-px">
          {matching.map((benchmark) => {
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
          {query && list.length > 0 && !matching.length ? <li role="status" className="px-3 py-3 text-xs text-ink-faint">{t('benchmark.noResults')}</li> : null}
        </ul>
      </div>
    </>
  )
}
