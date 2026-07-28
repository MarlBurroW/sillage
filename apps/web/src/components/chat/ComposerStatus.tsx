import { Flame, Snowflake, Waves, Wifi, WifiOff } from 'lucide-react'
import type { AgentKind } from '@sillage/protocol'
import type { BackgroundWork } from '../../lib/background'
import { AGENT_LABELS, AgentIcon } from '../AgentIcon'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

/**
 * Bande d'état sous la barre de saisie.
 *
 * Elle éloigne le composer du bord bas, mais surtout elle porte les deux informations
 * que l'en-tête ne donne pas : l'état de la liaison, et si la session CLI est encore
 * chargée. Le reste (modèle, worktree, quota) vit déjà en haut et n'est pas répété.
 */
export function ComposerStatus({
  agent,
  connected,
  warm,
  queued,
  background,
}: {
  agent: AgentKind
  connected: boolean
  /** Null tant que le serveur ne l'a pas annoncé, c'est-à-dire avant l'abonnement. */
  warm: boolean | null
  queued: number
  /** Travaux que le CLI poursuit en dehors du tour. Vide la plupart du temps. */
  background: BackgroundWork[]
}) {
  const t = useTranslate()
  return (
    <div
      className={cx(
        // La marge basse appartient au conteneur de la barre de saisie : cette bande
        // ne porte que son espacement au champ.
        'mx-auto flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-1',
        'px-1.5 pt-2 text-[0.6875rem] text-ink-faint',
      )}
    >
      <span className="flex items-center gap-1.5">
        <AgentIcon agent={agent} size={11} />
        {AGENT_LABELS[agent]}
      </span>

      {warm !== null ? (
        <span
          className="flex items-center gap-1"
          title={warm ? t('composer.status.warm.title') : t('composer.status.cold.title')}
        >
          {warm ? <Flame size={11} className="text-accent" /> : <Snowflake size={11} />}
          {warm ? t('composer.status.warm.label') : t('composer.status.cold.label')}
        </span>
      ) : null}

      <span
        className={cx('flex items-center gap-1', !connected && 'text-caution')}
        title={connected ? t('composer.status.connected.title') : t('composer.status.disconnected.title')}
      >
        {connected ? <Wifi size={11} /> : <WifiOff size={11} />}
        {connected ? t('composer.status.connected.label') : t('composer.status.disconnected.label')}
      </span>

      {background.length > 0 ? (
        <span
          className="flex items-center gap-1 text-accent"
          title={background.map((task) => task.description).join('\n')}
        >
          <Waves size={11} className="animate-pulse" />
          {t(
            background.length > 1 ? 'composer.status.background.many' : 'composer.status.background.one',
            { count: background.length },
          )}
        </span>
      ) : null}

      {queued > 0 ? (
        <span className="text-ink-soft">
          {t(queued > 1 ? 'composer.status.queued.many' : 'composer.status.queued.one', {
            count: queued,
          })}
        </span>
      ) : null}

      {/* Le raccourci ne se découvre pas tout seul, et il n'a pas de sens au doigt. */}
      <span className="ml-auto hidden pointer-fine:inline">{t('composer.status.shortcut')}</span>
    </div>
  )
}
