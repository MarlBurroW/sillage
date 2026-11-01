import { FlaskConical, Plus } from 'lucide-react'
import { useState } from 'react'
import { NavLink, useMatch, useNavigate } from 'react-router-dom'
import { benchmarkPath } from '@sillage/protocol'
import { BENCHMARK_STATE_LABELS, benchmarkProgress, benchmarkState, useBenchmarks, type BenchmarkState } from '../lib/benchmarks'
import { useTranslate } from '../lib/i18n'
import { IconButton, cx } from './ui'

const STATE_DOTS: Record<BenchmarkState, string> = {
  running: 'bg-accent animate-pulse',
  done: 'bg-positive',
  failed: 'bg-critical',
  cancelled: 'bg-line-strong',
}

/** Recent benchmarks beneath the heading; the page lists them all. */
const SHOWN = 6

/**
 * Account-level section below Discussions: benchmarks belong to nobody's project. Runs do not
 * appear here, nor among discussions; the benchmark page carries their measurements and links.
 */
export function SidebarBenchmarks({ onNavigate }: { onNavigate: () => void }) {
  const t = useTranslate()
  const navigate = useNavigate()
  const route = useMatch('/benchmarks/*')
  const [expanded, setExpanded] = useState(false)
  const { data: benchmarks } = useBenchmarks()
  const open = Boolean(route) || expanded
  const shown = (benchmarks ?? []).slice(0, SHOWN)

  return (
    <section className="sidebar-personal" aria-label={t('benchmark.title')} data-sidebar-benchmarks>
      <div className="flex min-h-11 items-center gap-1 px-3">
        <button
          type="button"
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left text-xs text-ink-soft hover:text-ink"
          aria-expanded={open}
          onClick={() => {
            if (!open) { setExpanded(true); navigate('/benchmarks'); onNavigate() }
            else if (!route) setExpanded(false)
            else { navigate('/benchmarks'); onNavigate() }
          }}
        >
          <FlaskConical size={14} />
          <span>{t('benchmark.title')}</span>
          {benchmarks?.length ? <span className="ml-auto text-[0.6875rem] tabular-nums text-ink-faint">{benchmarks.length}</span> : null}
        </button>
        <IconButton size="sm" label={t('benchmark.new')} onClick={() => { navigate('/benchmarks/new'); onNavigate() }}>
          <Plus size={15} />
        </IconButton>
      </div>
      {open ? (
        <ul className="max-h-64 overflow-y-auto px-2 pb-1">
          {shown.map((benchmark) => {
            const state = benchmarkState(benchmark)
            const progress = benchmarkProgress(benchmark)
            return (
              <li key={benchmark.id}>
                <NavLink
                  to={benchmarkPath(benchmark.id)}
                  onClick={onNavigate}
                  title={`${benchmark.name} · ${t(BENCHMARK_STATE_LABELS[state])}`}
                  className={({ isActive }) => cx(
                    'flex min-h-11 items-center gap-2 rounded-md px-2 text-[0.8125rem] text-ink-soft transition-colors hover:bg-surface-high hover:text-ink md:min-h-8 pointer-coarse:min-h-11',
                    isActive && 'bg-surface-high text-ink',
                  )}
                >
                  <span aria-hidden className={cx('size-1.5 shrink-0 rounded-full', STATE_DOTS[state])} />
                  <span className="sr-only">{t(BENCHMARK_STATE_LABELS[state])}</span>
                  <span className="min-w-0 flex-1 truncate">{benchmark.name}</span>
                  <span className="shrink-0 text-[0.6875rem] tabular-nums text-ink-faint">{progress.done}/{progress.total}</span>
                </NavLink>
              </li>
            )
          })}
          {!shown.length ? <li className="px-3 py-2 text-xs text-ink-faint">{t('benchmark.empty')}</li> : null}
        </ul>
      ) : null}
    </section>
  )
}
