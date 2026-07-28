import { useEffect, useRef, useState } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import type { UpdatePhase } from '@sillage/protocol'
import { Markdown } from '../components/chat/Markdown'
import { Badge, Banner, Button, Card, CardBody, CardHeader, ConfirmDialog } from '../components/ui'
import { api } from '../lib/api'
import { useCurrentUser } from '../lib/session'
import {
  useRefreshVersionInfo,
  useStartUpdate,
  useUpdateStatus,
  useVersionInfo,
} from '../lib/system'
import { SectionHeader } from './SettingsPage'

const PHASE_LABELS: Record<UpdatePhase, string> = {
  idle: 'En attente',
  downloading: 'Téléchargement…',
  extracting: 'Extraction…',
  switching: 'Bascule de version…',
  restarting: 'Redémarrage du service…',
  failed: 'Échec',
}

export function AboutSection() {
  const { data: user } = useCurrentUser()
  const { data: info } = useVersionInfo()
  const refresh = useRefreshVersionInfo()
  const startUpdate = useStartUpdate()
  const [confirming, setConfirming] = useState(false)
  const [tracking, setTracking] = useState(false)
  const { data: status } = useUpdateStatus(tracking)

  const isAdmin = user?.isAdmin ?? false
  const updating = tracking && status !== undefined && status.phase !== 'failed'

  // Une mise à jour peut avoir été lancée depuis un autre appareil : si le
  // serveur en signale une en cours au montage, on s'y accroche.
  const probedRef = useRef(false)
  useEffect(() => {
    if (probedRef.current || tracking) return
    probedRef.current = true
    void api
      .get<{ phase: UpdatePhase }>('/api/system/update/status')
      .then((current) => {
        if (current.phase !== 'idle' && current.phase !== 'failed') setTracking(true)
      })
      // Serveur injoignable ou session périmée : l'écran reste utilisable sans suivi.
      .catch(() => undefined)
  }, [tracking])

  useRestartWatch(status?.phase, status?.targetVersion ?? null)

  const startNow = () => {
    setConfirming(false)
    startUpdate.mutate(undefined, { onSuccess: () => setTracking(true) })
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title="À propos" description="Version installée et mises à jour." />

      <Card>
        <CardHeader title="Version" />
        <CardBody className="flex flex-col gap-2 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
            <dt className="text-ink-faint">Installée</dt>
            <dd className="font-medium">{info?.version ?? __APP_VERSION__}</dd>
            <dt className="text-ink-faint">Dernière publiée</dt>
            <dd className="flex items-center gap-2">
              {info?.latest ?? '·'}
              {info?.updateAvailable ? <Badge tone="accent">Mise à jour disponible</Badge> : null}
            </dd>
            <dt className="text-ink-faint">Build du</dt>
            <dd>
              <time dateTime={__BUILD_TIME__}>
                {new Date(__BUILD_TIME__).toLocaleString('fr-FR')}
              </time>
            </dd>
          </dl>

          {info?.checkError ? (
            <p className="text-xs text-ink-faint">
              {info.checkError === 'rate_limited'
                ? 'Vérification des mises à jour temporairement limitée par GitHub.'
                : 'Impossible de vérifier les mises à jour pour le moment.'}
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
                Vérifier maintenant
              </Button>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {info?.updateAvailable ? (
        <Card>
          <CardHeader
            title={`Nouveautés de la version ${info.latest}`}
            description="Tout ce qui a été publié depuis votre version, du plus récent au plus ancien."
          />
          <CardBody className="flex flex-col gap-4">
            {info.channel === 'docker' ? (
              <div className="flex flex-col gap-2 text-sm">
                <p className="text-ink-soft">
                  Cette instance tourne en Docker : mettez à jour en tirant la nouvelle image
                  puis en recréant le conteneur.
                </p>
                <pre className="overflow-x-auto rounded-md bg-surface-high px-3 py-2 font-mono text-xs">
                  docker pull ghcr.io/marlburrow/sillage:{info.latest}
                </pre>
              </div>
            ) : info.channel === 'installer' ? (
              isAdmin ? (
                <div>
                  <Button onClick={() => setConfirming(true)} disabled={updating}>
                    Mettre à jour vers {info.latest}
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-ink-faint">
                  Demandez à un administrateur d'effectuer la mise à jour.
                </p>
              )
            ) : (
              <p className="text-sm text-ink-faint">
                Installation gérée manuellement : récupérez la nouvelle version depuis GitHub.
              </p>
            )}

            {/* Les notes de release sont rédigées en anglais : elles viennent
                telles quelles de GitHub. */}
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
                    {new Date(release.publishedAt).toLocaleDateString('fr-FR')}
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
                ? 'La mise à jour a échoué'
                : `Mise à jour vers ${status.targetVersion ?? ''}`
            }
            description={PHASE_LABELS[status.phase]}
          />
          <CardBody className="flex flex-col gap-2">
            {status.phase === 'failed' && status.error ? (
              <Banner>{status.error}</Banner>
            ) : null}
            <pre className="max-h-48 overflow-y-auto rounded-md bg-surface-high px-3 py-2 font-mono text-xs whitespace-pre-wrap">
              {status.log.join('\n')}
            </pre>
            {status.phase === 'restarting' ? (
              <p className="text-xs text-ink-faint">
                Le service redémarre : la page se rechargera d'elle-même dès que la nouvelle
                version répondra.
              </p>
            ) : null}
            {status.phase === 'failed' ? (
              <div>
                <Button onClick={() => setConfirming(true)}>Réessayer</Button>
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Mettre à jour vers ${info?.latest ?? ''} ?`}
        confirmLabel="Mettre à jour"
        onConfirm={startNow}
        busy={startUpdate.isPending}
      >
        <p>
          Le service sera indisponible quelques secondes pendant le redémarrage. Les
          conversations en cours d'exécution seront interrompues et reprendront au prochain
          message.
        </p>
      </ConfirmDialog>
    </div>
  )
}

/**
 * Une fois le redémarrage engagé, l'ancien process ne répondra plus : on sonde
 * /api/health (route publique) jusqu'à ce que la nouvelle version réponde, puis
 * on recharge pour servir le frontend fraîchement déployé.
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
