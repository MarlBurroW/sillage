import { FlaskConical, Plus } from 'lucide-react'
import { Link, Navigate } from 'react-router-dom'
import { benchmarkPath } from '@sillage/protocol'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { Banner, Button, EmptyState } from '../components/ui'
import { useBenchmarks } from '../lib/benchmarks'
import { useTranslate } from '../lib/i18n'

/**
 * The benchmarks space has no list of its own: the navigation column is the list. Entering the
 * space opens the most recent benchmark, and this page only shows while there is none.
 */
export function BenchmarksPage() {
  const t = useTranslate()
  const { data: benchmarks, isPending, isError } = useBenchmarks()

  if (benchmarks?.[0]) return <Navigate to={benchmarkPath(benchmarks[0].id)} replace />

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3 md:px-6">
        <MobileNavigationButton />
        <FlaskConical size={19} className="shrink-0 text-ink-faint" />
        <h1 className="text-base font-semibold">{t('benchmark.title')}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        {isError ? <Banner>{t('benchmark.loadError')}</Banner> : isPending ? (
          <p role="status" className="text-sm text-ink-faint">{t('schedule.loading')}</p>
        ) : (
          <EmptyState
            icon={<FlaskConical size={22} />}
            title={t('benchmark.empty')}
            description={t('benchmark.emptyHint')}
            action={<Link to="/benchmarks/new"><Button size="sm" icon={<Plus size={15} />}>{t('benchmark.new')}</Button></Link>}
          />
        )}
      </div>
    </div>
  )
}
