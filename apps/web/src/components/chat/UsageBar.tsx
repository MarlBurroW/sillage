import type { UsageWindow } from '@sillage/protocol'
import { translate, useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

/**
 * Une fenêtre de quota, telle que le CLI la déclare. Partagée par le panneau détaillé
 * et par la page de brouillon, qui montrent la même mesure à deux moments.
 */

/**
 * Seuils d'alerte. Choix d'affichage, pas une information du CLI : aucun des deux
 * protocoles ne déclare de niveau de gravité exploitable ici.
 */
const CAUTION_AT = 0.75
const CRITICAL_AT = 0.9

function toneFor(utilization: number | null): string {
  if (utilization === null) return 'bg-line-strong'
  if (utilization >= CRITICAL_AT) return 'bg-critical'
  if (utilization >= CAUTION_AT) return 'bg-caution'
  return 'bg-accent'
}

/** Délai restant, à la maille qui se lit : jours, puis heures, puis minutes. */
function untilReset(resetsAt: number | null): string | null {
  if (resetsAt === null) return null
  const minutes = Math.round((resetsAt - Date.now()) / 60_000)
  if (minutes <= 0) return translate('usage.reset.imminent')
  if (minutes < 60) return translate('usage.reset.inMinutes', { minutes })

  const hours = Math.round(minutes / 60)
  if (hours < 48) return translate('usage.reset.inHours', { hours })
  return translate('usage.reset.inDays', { days: Math.round(hours / 24) })
}

/** Ancienneté de la lecture. Une heure absolue n'apprend rien sur sa fraîcheur. */
export function readAge(fetchedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - fetchedAt) / 1000))
  if (seconds < 60) return translate('usage.age.seconds', { seconds })
  const minutes = Math.round(seconds / 60)
  return minutes < 60
    ? translate('usage.age.minutes', { minutes })
    : translate('usage.age.hours', { hours: Math.round(minutes / 60) })
}

export function UsageBar({ window }: { window: UsageWindow }) {
  const t = useTranslate()
  const percent = window.utilization === null ? null : Math.round(window.utilization * 100)
  const reset = untilReset(window.resetsAt)

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate text-ink">{window.label}</span>
        <span className="shrink-0 font-medium text-ink">
          {percent === null ? '?' : `${percent} %`}
        </span>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-surface-high">
        <div
          className={cx('h-full rounded-full transition-[width]', toneFor(window.utilization))}
          // Un taux inconnu ne dessine rien : une barre vide dirait « zéro », ce qui
          // serait une affirmation que le CLI n'a pas faite.
          style={{ width: `${Math.min(percent ?? 0, 100)}%` }}
        />
      </div>

      {reset ? (
        <p className="text-[0.6875rem] text-ink-faint">{t('usage.reset.label', { reset })}</p>
      ) : null}
    </div>
  )
}
