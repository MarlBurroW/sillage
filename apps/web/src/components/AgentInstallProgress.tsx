import { useEffect, useState } from 'react'
import { useTranslate } from '../lib/i18n'
import { cx } from './ui'

export interface InstallProgress {
  startedAt: number
  fetched: number
  current: string | null
}

/** Le temps écoulé depuis `startedAt`, rafraîchi chaque seconde. */
function useElapsed(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return Math.max(0, Math.round((now - startedAt) / 1000))
}

/**
 * L'avancement d'une installation de CLI, partout où on peut en lancer une : la visite
 * de première ouverture et la page de nouvelle session.
 *
 * npm ne sait pas dire quelle part du paquet est arrivée, seulement qu'il télécharge
 * tel fichier et combien il en a déjà reçus. La barre est donc animée sans être
 * proportionnelle : son rôle est de montrer que ça avance, et les lignes dessous disent
 * quoi. Le temps écoulé répond à la question qu'on se pose devant un bouton muet :
 * « est-ce que c'est planté ? ».
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
