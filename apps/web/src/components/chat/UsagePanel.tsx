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
 * Account usage equivalent to /usage. Assume no known windows: display CLI inventory in reported
 * order. This let Fable gauges appear without specific code and supports future ones too.
 */

/**
 * Radix portals mount on open and unmount on close, guaranteeing usage refetch without client
 * freshness timers. Server caching guards actual CLI-process cost. Keep previous readings visible
 * during refetch rather than blanking the panel.
 */
function UsageContent({ agent, account }: { agent: AgentKind; account: string | null }) {
  const t = useTranslate()
  const { data: usage, error, isPending, isFetching } = useAgentUsage(agent, true, account)
  const refresh = useRefreshUsage(agent, account)
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
  account = null,
  open,
  onOpenChange,
}: {
  agent: AgentKind
  /** Conversation's additional Claude account, whose usage replaces CLI-login usage. */
  account?: string | null
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
          <UsageContent agent={agent} account={account} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
