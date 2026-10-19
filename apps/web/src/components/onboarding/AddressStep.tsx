import { Bell, Globe, Smartphone } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import { useAppSettings, useUpdateAppSettings } from '../../lib/app-settings'
import { useTranslate } from '../../lib/i18n'
import { useCapability } from '../../lib/instance'
import { currentOrigin, describeOrigin } from '../../lib/onboarding'
import { PushEnrol } from '../PushControls'
import { Badge, Card, CardBody, Field } from '../ui'
import { Question, StepTitle, Tip, Why, useCommit, useGate, type StepProps } from './shell'

/**
 * Adresse et téléphone, hébergé seulement.
 *
 * L'administrateur confirme l'adresse publique, proposée d'après celle par laquelle ce
 * navigateur est arrivé ; un membre la voit en lecture seule. Vient ensuite ce qui
 * concerne le téléphone, si l'on compte s'en servir : l'app à installer, et les
 * notifications de cet appareil.
 */
export function AddressStep({ nav, state, user, hostname }: StepProps) {
  const t = useTranslate()
  const admin = user?.isAdmin ?? false
  const phone = state.answers.devices === 'phone'
  const webPush = useCapability('webPush')
  const { data: appSettings } = useAppSettings()
  const updateApp = useUpdateAppSettings()

  // Null tant qu'on n'a pas tapé : l'adresse réglée, sinon celle de ce navigateur.
  const [draft, setDraft] = useState<string | null>(null)
  const configured = appSettings?.publicUrl ?? ''
  const url = admin ? (draft ?? (configured || currentOrigin())) : configured || currentOrigin()
  const info = describeOrigin(url)

  useGate(nav, { canContinue: !admin || info.valid, laterAllowed: true, skipAllowed: true })
  useCommit(nav, async () => {
    if (admin && appSettings && url !== configured) await updateApp.mutateAsync({ publicUrl: url })
  })

  const [qr, setQr] = useState<string | null>(null)
  useEffect(() => {
    if (!phone || !info.valid) {
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
  }, [url, phone, info.valid])

  const title = admin ? t(phone ? 'onboarding.address.title.both' : 'onboarding.address.title.address') : t('onboarding.address.title.phone')
  // Trois cas : joignable de partout ; locale (avec ou sans HTTPS) ; non locale mais en clair.
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
        <Question label={t('onboarding.address.public')} hint={t('onboarding.address.public.hint')}>
          <Field
            label={t('onboarding.address.public')}
            icon={<Globe size={16} />}
            value={url}
            onChange={(event) => setDraft(event.target.value)}
            error={info.valid ? undefined : t('onboarding.address.invalid')}
            hint={t(info.local ? 'onboarding.address.public.keep' : 'onboarding.address.public.explain')}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <div>{badge}</div>
        </Question>
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

      <div className={phone ? 'grid gap-3 md:grid-cols-2' : 'flex flex-col gap-3'}>
        {phone ? (
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
        ) : null}
        {webPush ? (
          <Card>
            <CardBody className="flex flex-col gap-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Bell size={15} /> {t('onboarding.address.notifications.title')}
              </h3>
              <PushEnrol />
              {phone ? <Tip>{t('onboarding.address.notifications.phone')}</Tip> : null}
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  )
}
