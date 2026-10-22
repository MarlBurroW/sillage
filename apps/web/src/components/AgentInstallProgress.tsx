import { useEffect, useState } from 'react'
import { useTranslate } from '../lib/i18n'
import { cx } from './ui'

export interface InstallProgress {
  startedAt: number
  fetched: number
  current: string | null
}

/** Elapsed time since startedAt refreshed every second. */
function useElapsed(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return Math.max(0, Math.round((now - startedAt) / 1000))
}

/**
 * CLI installation progress shared by onboarding and new-session pages. npm reports files and
 * counts but no total fraction, so animate without percentage; text explains actual progress.
 * Elapsed time answers whether an apparently silent installation is stuck.
 */
export function AgentInstallProgress({
  label,
  version,
  progress,
  className,
}: {
  label: string
  version: string
  progress: InstallProgress
  className?: string
}) {
  const t = useTranslate()
  const elapsed = useElapsed(progress.startedAt)
  const minutes = Math.floor(elapsed / 60)
  const seconds = elapsed % 60
  const duration = minutes > 0
    ? t('agent.install.progress.minutes', { minutes, seconds })
    : t('agent.install.progress.seconds', { seconds })

  return (
    <div role="status" aria-live="polite" className={cx('flex min-w-0 flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="min-w-0 truncate font-medium text-ink">
          {t('agent.install.running', { label, version })}
        </span>
        <span className="shrink-0 text-ink-faint tabular-nums">{duration}</span>
      </div>
      <div
        role="progressbar"
        aria-label={t('agent.install.running', { label, version })}
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-high"
      >
        <div className="sg-install-sweep h-full w-1/3 rounded-full bg-accent" />
      </div>
      <p className="min-w-0 truncate text-xs text-ink-faint">
        {progress.current
          ? t('agent.install.progress.fetch', { file: progress.current })
          : t('agent.install.progress.resolving')}
        {progress.fetched > 0 ? ` · ${t('agent.install.progress.files', { count: progress.fetched })}` : null}
      </p>
      <p className="text-xs text-ink-faint">{t('agent.install.progress.hint')}</p>
    </div>
  )
}
