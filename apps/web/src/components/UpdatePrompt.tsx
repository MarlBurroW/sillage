import { ArrowRight, Sparkles, RefreshCw, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router-dom'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { fetchDeployedVersion, parseBuildVersion, type BuildVersion } from '../lib/build-version'
import { hasUnsentDrafts, subscribeDrafts } from '../lib/composer-drafts'
import { useTranslate } from '../lib/i18n'
import { RELEASE_NOTES_PATH } from '../lib/release-notes'
import { Button, cx } from './ui'

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

const CURRENT = parseBuildVersion(__APP_VERSION__)

export function UpdatePrompt() {
  const t = useTranslate()
  const [updating, setUpdating] = useState(false)
  // "Later" folds the card into a pill rather than hiding it: the page keeps running old code
  // until it reloads, so the reminder stays.
  const [folded, setFolded] = useState(false)
  const [next, setNext] = useState<BuildVersion | null>(null)
  const unsent = useSyncExternalStore(subscribeDrafts, hasUnsentDrafts)
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
    if (!needRefresh) return
    let live = true
    void fetchDeployedVersion().then((version) => {
      if (live && version) setNext(parseBuildVersion(version))
    })
    return () => {
      live = false
    }
  }, [needRefresh])

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

  // A build identical to ours (a rebuild of the same commit) says nothing worth showing.
  const named = next && (next.label !== CURRENT.label || next.detail !== CURRENT.detail) ? next : null

  const reloadButton = (
    <Button
      size="sm"
      onClick={reload}
      // Reload takes seconds without visible changes; pending state prevents the prompt seeming
      // inert and inviting repeated clicks.
      busy={updating}
      icon={<RefreshCw size={15} aria-hidden="true" />}
    >
      {updating ? t('update.reloading') : t('update.reload')}
    </Button>
  )

  return (
    <div
      role="status"
      className={cx(
        // Place at top: above the composer it covered ongoing writing.
        'fixed top-[calc(var(--sg-safe-top)+0.75rem)] left-1/2 z-50 -translate-x-1/2',
        'sg-update-prompt',
      )}
    >
      {folded ? (
        <div className="surface flex items-center gap-1 rounded-full border border-accent/45 py-1 pr-1 pl-1 shadow-pop">
          <button
            type="button"
            onClick={() => setFolded(false)}
            className="flex min-h-9 items-center gap-2 rounded-full pr-2 pl-3 text-sm text-ink-soft hover:text-ink"
          >
            <span className="sg-update-dot size-2 shrink-0 rounded-full bg-accent" aria-hidden="true" />
            {named ? t('update.folded.version', { version: named.label }) : t('update.folded')}
          </button>
          <Button size="sm" onClick={reload} busy={updating} className="rounded-full" icon={<RefreshCw size={15} aria-hidden="true" />}>
            {updating ? t('update.reloading') : t('update.reload')}
          </Button>
        </div>
      ) : (
        <div
          className={cx(
            'surface w-[min(32rem,calc(100vw-1.5rem))] rounded-xl border border-accent/45 shadow-pop',
            'flex flex-col gap-3 p-4 sm:flex-row sm:items-start',
          )}
        >
          <div className="flex min-w-0 flex-1 gap-3">
            <span
              className="gradient-accent flex size-9 shrink-0 items-center justify-center rounded-full text-accent-ink"
              aria-hidden="true"
            >
              <Sparkles size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[0.9375rem] leading-tight font-semibold">{t('update.title')}</p>

              {named ? (
                <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
                  <span className="font-mono text-ink-faint" title={__APP_VERSION__}>
                    {CURRENT.label}
                  </span>
                  <ArrowRight size={13} className="text-ink-faint" aria-hidden="true" />
                  <span className="sr-only">{t('update.to')}</span>
                  <span className="rounded-md bg-accent-wash px-1.5 py-0.5 font-mono font-medium text-accent">
                    {named.label}
                  </span>
                  {named.detail ? <span className="font-mono text-xs text-ink-faint">{named.detail}</span> : null}
                  {named.release ? (
                    <Link
                      to={RELEASE_NOTES_PATH}
                      onClick={() => setFolded(true)}
                      className="ml-1 text-accent underline-offset-2 hover:underline"
                    >
                      {t('update.notes')}
                    </Link>
                  ) : null}
                </p>
              ) : null}

              <p className="mt-1.5 text-sm text-ink-soft">{t('update.description')}</p>

              {unsent ? (
                <p className="mt-2 flex items-start gap-1.5 text-sm text-caution">
                  <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
                  {t('update.unsentDrafts')}
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 gap-2 sm:flex-col-reverse sm:items-stretch max-sm:[&>*]:flex-1">
            <Button size="sm" variant="ghost" onClick={() => setFolded(true)} disabled={updating}>
              {t('update.later')}
            </Button>
            {reloadButton}
          </div>
        </div>
      )}
    </div>
  )
}
