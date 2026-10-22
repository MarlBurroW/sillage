import { RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { useTranslate } from '../lib/i18n'
import { cx } from './ui'

/**
 * Offer reload after installing a new version. Previously new service workers took control while
 * loaded pages continued running old code without notification. Installed PWAs resuming from memory
 * might show fixes only after complete closure. Offer rather than force reload to preserve messages
 * being composed.
 */

/**
 * Installed PWAs rarely navigate, so browsers rarely recheck service workers. Periodic checks make
 * deployed versions discoverable without closing the app.
 */
const CHECK_INTERVAL_MS = 30 * 60 * 1000

/**
 * After this deadline restore interaction instead of leaving a dead button. Reload waits several
 * seconds for service-worker takeover; if nothing happens by then takeover failed and users must be
 * able to retry.
 */
const STALLED_MS = 15_000

export function UpdatePrompt() {
  const t = useTranslate()
  const [updating, setUpdating] = useState(false)
  const stalled = useRef<number | null>(null)

  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return

      // Check immediately as well as periodically. PWAs resume without navigation; otherwise
      // updates might wait half an hour or never appear if closed sooner.
      void registration.update()

      const timer = setInterval(() => void registration.update(), CHECK_INTERVAL_MS)
      // The page lives as long as the app: the interval needs no independent end but never outlives the document.
      window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
    },
  })

  useEffect(() => {
    return () => {
      if (stalled.current !== null) clearTimeout(stalled.current)
    }
  }, [])

  if (!needRefresh) return null

  const reload = () => {
    setUpdating(true)
    stalled.current = window.setTimeout(() => setUpdating(false), STALLED_MS)
    void updateServiceWorker(true)
  }

  return (
    <div
      role="status"
      className={cx(
        // Place at top: above the composer it covered ongoing writing.
        'surface fixed top-[calc(var(--sg-safe-top)+0.75rem)] left-1/2 z-50',
        'flex -translate-x-1/2 items-center gap-3',
        'rounded-full border border-line py-1.5 pr-1.5 pl-4 shadow-pop',
      )}
    >
      <span className="text-sm text-ink-soft">{t('update.available')}</span>
      <button
        type="button"
        onClick={reload}
        // Reload takes seconds without visible changes; pending state prevents the prompt seeming
        // inert and inviting repeated clicks.
        disabled={updating}
        className={cx(
          'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium',
          'gradient-accent text-accent-ink transition-[filter] hover:brightness-110',
          'disabled:pointer-events-none disabled:opacity-70',
        )}
      >
        <RefreshCw size={14} className={cx(updating && 'animate-spin')} />
        {updating ? t('update.reloading') : t('update.reload')}
      </button>
    </div>
  )
}
