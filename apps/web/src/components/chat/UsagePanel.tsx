import * as Dialog from '@radix-ui/react-dialog'
import { Loader, RefreshCw, X } from 'lucide-react'
import { useState } from 'react'
import type { AgentKind } from '@sillage/protocol'
import { AGENT_LABELS } from '../AgentIcon'
import { locale, useTranslate } from '../../lib/i18n'
import { useAgentUsage, useRefreshUsage } from '../../lib/usage'
import { Banner, IconButton, cx } from '../ui'
import { UsageBar, readAge } from './UsageBar'

/**
 * Consommation du compte, l'équivalent de `/usage`.
 *
 * Le panneau ne connaît aucune fenêtre à l'avance : il affiche ce que le CLI déclare,
 * dans l'ordre reçu. C'est ce qui a permis à la jauge Fable d'apparaître sans que rien
 * ne soit écrit à son sujet, et ce qui fera apparaître la suivante.
 */

/**
 * Monté à l'ouverture, démonté à la fermeture par le portail de Radix.
 *
 * C'est ce qui fait qu'ouvrir le panneau redemande systématiquement la consommation,
 * sans dépendre d'une durée de fraîcheur côté client. Le seul garde-fou est le cache
 * du serveur, placé là où se trouve le coût réel : une lecture y démarre un process
 * CLI. La valeur précédente reste affichée pendant la relecture, donc rouvrir
 * n'efface pas l'écran pour le remplir à nouveau.
 */
function UsageContent({ agent }: { agent: AgentKind }) {
  const t = useTranslate()
  const { data: usage, error, isPending, isFetching } = useAgentUsage(agent)
  const refresh = useRefreshUsage(agent)
  const [refreshing, setRefreshing] = useState(false)

  const reload = async () => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  const busy = refreshing || isFetching

  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2 pt-safe">
        <Dialog.Title className="flex-1 text-sm font-semibold">
          {t('usage.title', { agent: AGENT_LABELS[agent] })}
        </Dialog.Title>
        <IconButton label={t('usage.refresh')} onClick={() => void reload()} disabled={busy}>
          <RefreshCw size={16} className={cx(busy && 'animate-spin')} />
        </IconButton>
        <Dialog.Close asChild>
          <IconButton label={t('usage.close')}>
            <X size={18} />
          </IconButton>
        </Dialog.Close>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 pb-safe">
        {isPending ? (
          <div className="flex items-center justify-center py-10 text-ink-faint">
            <Loader size={22} className="animate-spin" aria-label={t('usage.loading')} />
          </div>
        ) : null}

        {error ? (
          <Banner>{error instanceof Error ? error.message : t('usage.error')}</Banner>
        ) : null}

        {usage ? (
          <div className="flex flex-col gap-4">
            {usage.plan ? (
              <p className="text-xs text-ink-soft">
                {t('usage.plan')} <span className="font-medium text-ink">{usage.plan}</span>
              </p>
            ) : null}

            {!usage.limitsAvailable ? (
              <p className="text-sm text-ink-faint">{t('usage.noLimits')}</p>
            ) : (
              <div className="flex flex-col gap-3.5">
                {usage.windows.map((window) => (
                  <UsageBar key={window.id} window={window} />
                ))}
              </div>
            )}

            {usage.credits ? (
              <div className="flex flex-col gap-1 border-t border-line pt-3">
                <div className="flex items-baseline gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-ink">{usage.credits.label}</span>
                  <span className="shrink-0 text-[0.6875rem] text-ink-faint">
                    {usage.credits.enabled ? t('usage.credits.enabled') : t('usage.credits.disabled')}
                  </span>
                </div>
                {usage.credits.detail ? (
                  <p className="text-[0.6875rem] text-ink-faint">{usage.credits.detail}</p>
                ) : null}
              </div>
            ) : null}

            <p
              className="text-[0.6875rem] text-ink-faint"
              title={new Date(usage.fetchedAt).toLocaleString(locale())}
            >
              {t('usage.readAt', { age: readAge(usage.fetchedAt) })}
            </p>
          </div>
        ) : null}
      </div>
    </>
  )
}

export function UsagePanel({
  agent,
  open,
  onOpenChange,
}: {
  agent: AgentKind
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          className={cx(
            'surface fixed z-50 flex flex-col overflow-hidden border-line shadow-pop',
            'inset-0 border-0',
            'sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-h-[85dvh] sm:w-[min(26rem,92vw)]',
            'sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:border',
          )}
        >
          <UsageContent agent={agent} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
