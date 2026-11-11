import { Check, Copy, Radio, ShieldCheck, Smartphone } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import { REMOTE_ACCESS_HTTPS_PORT, type RemoteAccessState } from '@sillage/protocol'
import { Badge, Banner, Card, CardBody, CardHeader, EmptyState, IconButton, Switch } from '../components/ui'
import { SectionHeader } from './SettingsPage'
import { ApiRequestError } from '../lib/api'
import { useCopy } from '../lib/clipboard'
import { useTranslate } from '../lib/i18n'
import { useRemoteAccess, useSetRemoteAccess } from '../lib/remote-access'
import { useCurrentUser } from '../lib/session'

/**
 * Desktop remote access: the server stays on 127.0.0.1 and Tailscale Serve lends it the
 * machine's private HTTPS address. The page reads the Tailscale client's state, flips the
 * acceptance on the server and shows the address to open on the other devices.
 */
export function RemoteAccessSettingsPage() {
  const t = useTranslate()
  const { data: me } = useCurrentUser()
  const isAdmin = me?.isAdmin === true
  const { data: state, error } = useRemoteAccess(isAdmin)
  const toggle = useSetRemoteAccess()

  if (!isAdmin) {
    return <EmptyState icon={<ShieldCheck size={22} />} title={t('remoteAccess.adminOnly.title')} description={t('remoteAccess.adminOnly.description')} />
  }

  const tailscale = state?.tailscale
  const ready = tailscale?.state === 'running' && tailscale.login !== null && tailscale.https

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title={t('remoteAccess.section.title')} description={t('remoteAccess.section.description')} />

      <Card>
        <CardHeader
          title={t('remoteAccess.toggle.title')}
          description={t('remoteAccess.toggle.description')}
          icon={<Radio size={16} />}
          actions={
            <Switch
              checked={state?.enabled === true}
              // Turning off always works, even once Tailscale is gone: the acceptance must be revocable.
              disabled={state === undefined || toggle.isPending || (!state.enabled && !ready)}
              label={t('remoteAccess.toggle.label')}
              onCheckedChange={(checked) => toggle.mutate(checked)}
            />
          }
        />
        <CardBody className="flex flex-col gap-3">
          {error instanceof ApiRequestError ? <Banner tone="critical">{error.message}</Banner> : null}
          {toggle.error instanceof ApiRequestError ? <Banner tone="critical">{toggle.error.message}</Banner> : null}
          {state ? <TailscaleStatusLine state={state} /> : null}
          {state?.enabled && state.url ? <Address state={state} /> : null}
          {state?.enabled ? <ServeNotices state={state} /> : null}
          {state?.enabled ? <p className="text-xs text-ink-faint">{t('remoteAccess.awake')}</p> : null}
        </CardBody>
      </Card>
    </div>
  )
}

/** What the Tailscale client reports, and what still blocks enabling. */
function TailscaleStatusLine({ state }: { state: RemoteAccessState }) {
  const t = useTranslate()
  const { tailscale } = state
  if (tailscale.state === 'missing') {
    return (
      <Banner tone="info">
        {t('remoteAccess.tailscale.missing')}{' '}
        <a href="https://tailscale.com/download" target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">
          {t('remoteAccess.tailscale.download')}
        </a>
      </Banner>
    )
  }
  if (tailscale.state === 'stopped') return <Banner tone="caution">{t('remoteAccess.tailscale.stopped')}</Banner>
  if (tailscale.state === 'error') return <Banner tone="critical">{t('remoteAccess.tailscale.error', { message: tailscale.message })}</Banner>
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
        <Badge tone="positive">{t('remoteAccess.tailscale.connected')}</Badge>
        <span className="font-mono text-xs">{tailscale.hostname}</span>
        {tailscale.login ? <span className="text-xs text-ink-faint">{t('remoteAccess.tailscale.login', { login: tailscale.login })}</span> : null}
      </div>
      {tailscale.login === null ? <Banner tone="caution">{t('remoteAccess.tailscale.tagged')}</Banner> : null}
      {!tailscale.https ? (
        <Banner tone="caution">
          {t('remoteAccess.tailscale.httpsOff')}{' '}
          <a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">
            {t('remoteAccess.tailscale.httpsEnable')}
          </a>
        </Banner>
      ) : null}
      {state.enabled && state.hostname && state.hostname !== tailscale.hostname ? (
        <Banner tone="caution">{t('remoteAccess.renamed', { recorded: state.hostname, current: tailscale.hostname })}</Banner>
      ) : null}
    </div>
  )
}

/** The address to open elsewhere, as text and as a code the phone scans. */
function Address({ state }: { state: RemoteAccessState }) {
  const t = useTranslate()
  const { state: copied, copy } = useCopy()
  const url = state.url ?? ''
  const [qr, setQr] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    QRCode.toDataURL(url, { margin: 1, width: 176 })
      .then((data) => {
        if (live) setQr(data)
      })
      .catch(() => setQr(null))
    return () => {
      live = false
    }
  }, [url])

  return (
    <div className="flex flex-wrap items-start gap-4 rounded-lg border border-line bg-surface p-4">
      {qr ? <img src={qr} alt={t('remoteAccess.address.qr')} width={112} height={112} className="size-28 shrink-0 rounded-md" /> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Smartphone size={15} /> {t('remoteAccess.address.title')}
        </h3>
        <div className="flex items-center gap-2">
          <a href={url} target="_blank" rel="noreferrer" className="min-w-0 break-all font-mono text-sm text-accent underline-offset-2 hover:underline">
            {url}
          </a>
          <IconButton label={t(copied === 'copied' ? 'remoteAccess.address.copied' : 'remoteAccess.address.copy')} size="sm" onClick={() => copy(url)}>
            {copied === 'copied' ? <Check size={14} /> : <Copy size={14} />}
          </IconButton>
        </div>
        <p className="text-xs text-ink-faint">{t('remoteAccess.address.explain', { login: state.login ?? '' })}</p>
      </div>
    </div>
  )
}

/** Serve is Tailscale's, not Sillage's: say when the mapping does not lead here and how to fix it. */
function ServeNotices({ state }: { state: RemoteAccessState }) {
  const t = useTranslate()
  const command = `tailscale serve --bg --https=${REMOTE_ACCESS_HTTPS_PORT} ${state.port}`
  const mismatch = state.serve.target !== state.port
  return (
    <>
      {state.serve.funnel ? <Banner tone="critical">{t('remoteAccess.serve.funnel')}</Banner> : null}
      {mismatch ? (
        <Banner tone="caution">
          <span className="block">
            {state.serveError
              ? t('remoteAccess.serve.refused', { message: state.serveError })
              : state.serve.target === null
                ? t('remoteAccess.serve.missing')
                : t('remoteAccess.serve.elsewhere', { port: state.serve.target })}
          </span>
          <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-sunken px-3 py-2 font-mono text-xs leading-relaxed text-ink-soft">{command}</pre>
        </Banner>
      ) : null}
    </>
  )
}
