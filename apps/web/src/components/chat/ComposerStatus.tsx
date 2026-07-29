import { Flame, Snowflake } from 'lucide-react'
import type { AgentKind } from '@sillage/protocol'
import { AGENT_LABELS, AgentIcon } from '../AgentIcon'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

/**
 * Ce qui est toujours vrai d'une conversation, sous la barre de saisie : le CLI, la
 * session chargée ou non, la liaison, le raccourci d'envoi.
 *
 * Rien de ce qui va et vient n'a sa place ici. Les signaux sont au-dessus du composer,
 * en couleur ; cette ligne-ci reste grise et immobile, et ne doit jamais attirer l'œil.
 * Les mélanger donnait à l'attente d'une réponse le même poids visuel qu'un rappel de
 * raccourci clavier.
 */
export function ComposerStatus({
  agent,
  connected,
  warm,
}: {
  agent: AgentKind
  connected: boolean
  /** Null tant que le serveur ne l'a pas annoncé, c'est-à-dire avant l'abonnement. */
  warm: boolean | null
}) {
  const t = useTranslate()

  return (
    <div
      className={cx(
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
          {warm ? <Flame size={11} /> : <Snowflake size={11} />}
          {warm ? t('composer.status.warm.label') : t('composer.status.cold.label')}
        </span>
      ) : null}

      {/* La liaison n'est dite ici que lorsqu'elle fonctionne. Coupée, elle devient un
          signal au-dessus du composer, où l'ambiant va quand il tourne mal. */}
      {connected ? (
        <span title={t('composer.status.connected.title')}>
          {t('composer.status.connected.label')}
        </span>
      ) : null}

      {/* Le raccourci ne se découvre pas tout seul, et il n'a pas de sens au doigt. */}
      <span className="ml-auto hidden pointer-fine:inline">{t('composer.status.shortcut')}</span>
    </div>
  )
}
