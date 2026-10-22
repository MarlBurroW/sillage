import { Flame, Snowflake } from 'lucide-react'
import type { AgentKind } from '@sillage/protocol'
import { AGENT_LABELS, AgentIcon } from '../AgentIcon'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

/**
 * Persistent conversation facts beneath input: CLI, loaded session, connection, send shortcut.
 * Changing signals belong above in color; this quiet gray row never attracts attention. Mixing them
 * gave response waits the same weight as shortcut reminders.
 */
export function ComposerStatus({
  agent,
  connected,
  warm,
}: {
  agent: AgentKind
  connected: boolean
  /** Null until announced by the server after subscription. */
  warm: boolean | null
}) {
  const t = useTranslate()

  return (
    <div
      className={cx(
        'mx-auto flex sg-conversation-width flex-wrap items-center gap-x-3 gap-y-1',
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

      {/* Show connections here only while healthy; broken ambient state becomes a signal above the composer. */}
      {connected ? (
        <span title={t('composer.status.connected.title')}>
          {t('composer.status.connected.label')}
        </span>
      ) : null}

      {/* Shortcuts need discoverability but have no touch meaning. */}
      <span className="ml-auto hidden pointer-fine:inline">{t('composer.status.shortcut')}</span>
    </div>
  )
}
