import { useEffect, useRef, useState } from 'react'
import { Compass, ExternalLink, RefreshCw } from 'lucide-react'
import { DEFAULT_ONBOARDING, type UpdatePhase } from '@sillage/protocol'
import { Markdown } from '../components/chat/Markdown'
import { Badge, Banner, Button, Card, CardBody, CardHeader, ConfirmDialog } from '../components/ui'
import { api } from '../lib/api'
import { locale, useTranslate, type MessageKey } from '../lib/i18n'
import { useCurrentUser } from '../lib/session'
import { useUpdateOnboarding, useUserSettings } from '../lib/user-settings'
import {
  useRefreshVersionInfo,
  useStartUpdate,
  useUpdateStatus,
  useVersionInfo,
} from '../lib/system'
import { SectionHeader } from './SettingsPage'

const PHASE_LABEL_KEYS: Record<UpdatePhase, MessageKey> = {
  idle: 'about.update.phase.idle',
  downloading: 'about.update.phase.downloading',
  extracting: 'about.update.phase.extracting',
  switching: 'about.update.phase.switching',
  restarting: 'about.update.phase.restarting',
  failed: 'about.update.phase.failed',
}

export function AboutSection() {
  const t = useTranslate()
  const { data: user } = useCurrentUser()
  const { data: info } = useVersionInfo()
  const refresh = useRefreshVersionInfo()
  const startUpdate = useStartUpdate()
  const [confirming, setConfirming] = useState(false)
  const [tracking, setTracking] = useState(false)
  const { data: status } = useUpdateStatus(tracking)

  const { data: settings } = useUserSettings()
  const replay = useUpdateOnboarding()
  const isAdmin = user?.isAdmin ?? false
  const updating = tracking && status !== undefined && status.phase !== 'failed'

  // An update may have started on another device: if the server
  // reports one in progress at mount time, attach to it.
  const probedRef = useRef(false)
  useEffect(() => {
    if (probedRef.current || tracking) return
    probedRef.current = true
    void api
      .get<{ phase: UpdatePhase }>('/api/system/update/status')
      .then((current) => {
        if (current.phase !== 'idle' && current.phase !== 'failed') setTracking(true)
      })
      // Server unreachable or session expired: the screen remains usable without tracking.
      .catch(() => undefined)
  }, [tracking])

  useRestartWatch(status?.phase, status?.targetVersion ?? null)

  const startNow = () => {
    setConfirming(false)
    startUpdate.mutate(undefined, { onSuccess: () => setTracking(true) })
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title={t('about.title')} description={t('about.description')} />

      {/* Replay onboarding here: reopen at the first step without undoing anything. */}
      <Card>
        <CardHeader title={t('about.tour.title')} description={t('about.tour.description')} />
        <CardBody>
          <Button
            variant="secondary"
            icon={<Compass size={15} />}
            disabled={replay.isPending}
            onClick={() => replay.mutate({ ...DEFAULT_ONBOARDING, pending: true, answers: settings?.onboarding.answers ?? DEFAULT_ONBOARDING.answers })}
          >
            {t('about.tour.replay')}
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('about.version.card')} />
        <CardBody className="flex flex-col gap-2 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
            <dt className="text-ink-faint">{t('about.version.installed')}</dt>
            <dd className="font-medium">{info?.version ?? __APP_VERSION__}</dd>
            <dt className="text-ink-faint">{t('about.version.latest')}</dt>
            <dd className="flex items-center gap-2">
              {info?.latest ?? '·'}
              {info?.updateAvailable ? (
                <Badge tone="accent">{t('about.badge.updateAvailable')}</Badge>
              ) : null}
            </dd>
            <dt className="text-ink-faint">{t('about.build')}</dt>
            <dd>
              <time dateTime={__BUILD_TIME__}>
                {new Date(__BUILD_TIME__).toLocaleString(locale())}
              </time>
            </dd>
          </dl>

          {info?.checkError ? (
            <p className="text-xs text-ink-faint">
              {info.checkError === 'rate_limited'
                ? t('about.check.rateLimited')
                : t('about.check.failed')}
            </p>
          ) : null}

          {isAdmin ? (
            <div>
              <Button
                variant="ghost"
                onClick={() => refresh.mutate()}
                disabled={refresh.isPending}
              >
                <RefreshCw size={14} className={refresh.isPending ? 'animate-spin' : undefined} />
                {t('about.check.now')}
              </Button>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {info?.updateAvailable ? (
        <Card>
          <CardHeader
            title={t('about.news.title', { version: info.latest ?? '' })}
            description={t('about.news.description')}
          />
          <CardBody className="flex flex-col gap-4">
            {info.channel === 'docker' ? (
              <div className="flex flex-col gap-2 text-sm">
                <p className="text-ink-soft">{t('about.docker.instructions')}</p>
                <pre className="overflow-x-auto rounded-md bg-surface-high px-3 py-2 font-mono text-xs">
                  docker pull ghcr.io/marlburrow/sillage:{info.latest}
                </pre>
              </div>
            ) : info.channel === 'installer' ? (
              isAdmin ? (
                <div>
                  <Button onClick={() => setConfirming(true)} disabled={updating}>
                    {t('about.update.action', { version: info.latest ?? '' })}
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-ink-faint">{t('about.update.askAdmin')}</p>
              )
            ) : info.channel === 'desktop' ? (
              <p className="text-sm text-ink-faint">{t('about.desktop.instructions')}</p>
            ) : (
              <p className="text-sm text-ink-faint">{t('about.manual.instructions')}</p>
            )}

            {/*
             * Release notes are written in English and come directly from GitHub.
             */}
            {info.releases.map((release) => (
              <article key={release.tag} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
                <header className="mb-1.5 flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold">{release.name}</h3>
                  <a
                    href={release.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex shrink-0 items-center gap-1 text-xs text-ink-faint hover:text-ink"
                  >
                    {new Date(release.publishedAt).toLocaleDateString(locale())}
                    <ExternalLink size={12} />
                  </a>
                </header>
                <Markdown text={release.body} />
              </article>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {tracking && status ? (
        <Card>
          <CardHeader
            title={
              status.phase === 'failed'
                ? t('about.update.failed.title')
                : t('about.update.title', { version: status.targetVersion ?? '' })
            }
            description={t(PHASE_LABEL_KEYS[status.phase])}
          />
          <CardBody className="flex flex-col gap-2">
            {status.phase === 'failed' && status.error ? (
              <Banner>{status.error}</Banner>
            ) : null}
            <pre className="max-h-48 overflow-y-auto rounded-md bg-surface-high px-3 py-2 font-mono text-xs whitespace-pre-wrap">
              {status.log.join('\n')}
            </pre>
            {status.phase === 'restarting' ? (
              <p className="text-xs text-ink-faint">{t('about.restarting.message')}</p>
            ) : null}
            {status.phase === 'failed' ? (
              <div>
                <Button onClick={() => setConfirming(true)}>{t('about.retry')}</Button>
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('about.confirm.title', { version: info?.latest ?? '' })}
        confirmLabel={t('about.confirm.action')}
        onConfirm={startNow}
        busy={startUpdate.isPending}
      >
        <p>{t('about.confirm.body')}</p>
      </ConfirmDialog>
    </div>
  )
}

/**
 * Once restart begins, the old process stops responding: poll the public `/api/health` route
 * until the new version responds, then reload to serve the freshly deployed frontend.
 */
function useRestartWatch(phase: UpdatePhase | undefined, targetVersion: string | null) {
  useEffect(() => {
    if (phase !== 'restarting' || !targetVersion) return
    const timer = setInterval(() => {
      void fetch('/api/health', { cache: 'no-store' })
        .then((res) => (res.ok ? (res.json() as Promise<{ version?: string }>) : null))
        .then((health) => {
          if (health?.version === targetVersion) window.location.reload()
        })
        .catch(() => undefined)
    }, 2000)
    return () => clearInterval(timer)
  }, [phase, targetVersion])
}
