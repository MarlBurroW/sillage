import { Bell, Globe, Smartphone } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import { useAppSettings, useUpdateAppSettings } from '../../lib/app-settings'
import { useTranslate } from '../../lib/i18n'
import { useCapability } from '../../lib/instance'
import { currentOrigin, describeOrigin } from '../../lib/onboarding'
import { PushEnrol } from '../PushControls'
import { Badge, Banner, Card, CardBody, Field } from '../ui'
import { StepTitle, Tip, Why, useCommit, useGate, type StepProps } from './shell'

/**
 * Address and phone for hosted instances only. Administrators confirm the public URL inferred from
 * this browser's origin; members see it read-only. Then phone installation and this device's
 * notifications, for everyone.
 */
export function AddressStep({ nav, user, hostname }: StepProps) {
  const t = useTranslate()
  const admin = user?.isAdmin ?? false
  const webPush = useCapability('webPush')
  const { data: appSettings } = useAppSettings()
  const updateApp = useUpdateAppSettings()

  // Null until typing: use configured address, otherwise this browser's origin.
  const [draft, setDraft] = useState<string | null>(null)
  const configured = appSettings?.publicUrl ?? ''
  const url = admin ? (draft ?? (configured || currentOrigin())) : configured || currentOrigin()
  const info = describeOrigin(url)

  /*
   * Once a public address is saved, the server answers on that host only (see
   * `registerServerOriginGuard`). Saving is therefore no longer a harmless note for links:
   * - an untouched local address is not saved at all, so the instance keeps answering wherever it
   *   is reached, including the HTTPS address set up later;
   * - an address other than the one this browser uses must answer before it is saved, and the
   *   browser follows it there, since this one stops being served.
   */
  const target = info.valid ? new URL(url).origin : ''
  const moves = admin && info.valid && target !== currentOrigin()
  const pins = draft !== null || !info.local

  useGate(nav, { canContinue: !admin || info.valid, laterAllowed: true, skipAllowed: true })
  useCommit(nav, async () => {
    if (!admin || !appSettings || !pins || target === configured) return
    if (moves) {
      // Opaque on purpose: only whether something answers there can be read across origins.
      await fetch(`${target}/api/health`, { mode: 'no-cors', cache: 'no-store' }).catch(() => {
        throw new Error(t('onboarding.address.unreachable'))
      })
    }
    await updateApp.mutateAsync({ publicUrl: target })
    if (moves) {
      window.location.assign(`${target}/bienvenue`)
      // Hold the step until the browser has left: the next request here would be refused.
      await new Promise(() => {})
    }
  })

  const [qr, setQr] = useState<string | null>(null)
  useEffect(() => {
    if (!info.valid) {
      setQr(null)
      return
    }
    let live = true
    QRCode.toDataURL(url, { margin: 1, width: 176 })
      .then((data) => {
        if (live) setQr(data)
      })
      .catch(() => setQr(null))
    return () => {
      live = false
    }
  }, [url, info.valid])

  const title = t(admin ? 'onboarding.address.title.both' : 'onboarding.address.title.phone')
  // Three cases: globally reachable, local with or without HTTPS, or nonlocal plaintext.
  const badge = info.valid ? (
    info.https && !info.local ? (
      <Badge tone="positive">{t('onboarding.address.reachable')}</Badge>
    ) : (
      <Badge tone="caution">
        {t(info.local ? (info.https ? 'onboarding.address.localHttps' : 'onboarding.address.local') : 'onboarding.address.noHttps')}
      </Badge>
    )
  ) : null

  return (
    <>
      <StepTitle title={title} lead={t(admin ? 'onboarding.address.lead.admin' : 'onboarding.address.lead.member')} />

      {admin ? (
        <div className="flex flex-col gap-2">
          <Field
            label={t('onboarding.address.public')}
            icon={<Globe size={16} />}
            value={url}
            onChange={(event) => setDraft(event.target.value)}
            error={info.valid ? undefined : t('onboarding.address.invalid')}
            hint={t(info.local && draft === null ? 'onboarding.address.public.keep' : 'onboarding.address.public.explain')}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <div>{badge}</div>
          {moves ? <Banner tone="caution">{t('onboarding.address.moves', { current: currentOrigin() })}</Banner> : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3">
          <Globe size={16} className="text-ink-faint" />
          <span className="min-w-0 flex-1 break-all font-mono text-sm text-ink">{url}</span>
          {badge}
        </div>
      )}

      {info.local || !info.https ? (
        <Why>
          <b>{t(info.local ? 'onboarding.address.tailscale.title' : 'onboarding.address.https.title')}</b>{' '}
          {t(info.local ? (admin ? 'onboarding.address.tailscale.body' : 'onboarding.address.tailscale.member') : admin ? 'onboarding.address.https.body' : 'onboarding.address.https.member')}
          {admin ? (
            <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-sunken px-3 py-2 font-mono text-xs leading-relaxed text-ink-soft">
              {`# ${t('onboarding.address.tailscale.comment', { host: hostname })}\ntailscale serve --bg --https=443 7317`}
            </pre>
          ) : null}
          {admin ? (
            <span className="mt-2 block">
              {t('onboarding.address.tailscale.others')}{' '}
              <a href="https://github.com/MarlBurroW/sillage/blob/main/docs/remote-access.md" target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">
                {t('onboarding.address.guide')}
              </a>
            </span>
          ) : null}
        </Why>
      ) : admin ? (
        <Tip>
          {t('onboarding.address.reachable.tip')}{' '}
          <a href="https://github.com/MarlBurroW/sillage/blob/main/docs/remote-access.md" target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">
            {t('onboarding.address.guide')}
          </a>
        </Tip>
      ) : null}

      {/* Following a turn away from the desk is what a hosted instance is for: shown to everyone. */}
      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardBody className="flex flex-col gap-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Smartphone size={15} /> {t('onboarding.address.install.title')}
            </h3>
            <div className="flex gap-3">
              {qr ? (
                <img src={qr} alt={t('onboarding.address.install.qr')} width={88} height={88} className="size-22 shrink-0 rounded-md" />
              ) : null}
              <div className="min-w-0 text-sm text-ink-soft">
                <p>{t('onboarding.address.install.scan')}</p>
                <ol className="mt-1 list-decimal pl-5 text-xs leading-relaxed [&_b]:font-semibold [&_b]:text-ink">
                  <li>
                    <b>iPhone</b> : {t('onboarding.address.install.ios')}
                  </li>
                  <li>
                    <b>Android</b> : {t('onboarding.address.install.android')}
                  </li>
                </ol>
              </div>
            </div>
            <Tip>{t('onboarding.address.install.why')}</Tip>
          </CardBody>
        </Card>
        {webPush ? (
          <Card>
            <CardBody className="flex flex-col gap-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Bell size={15} /> {t('onboarding.address.notifications.title')}
              </h3>
              <PushEnrol />
              <Tip>{t('onboarding.address.notifications.phone')}</Tip>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  )
}
