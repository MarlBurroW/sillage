import { MonitorPlay, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { PREVIEW_HOST_PREFIX } from '@sillage/protocol'
import { Banner, Button, Card, CardBody, CardHeader, EmptyState, Field } from '../components/ui'
import { SectionHeader } from './SettingsPage'
import { ApiRequestError } from '../lib/api'
import { useAppSettings, useUpdateAppSettings } from '../lib/app-settings'
import { usePreviews } from '../lib/previews'
import { useTranslate } from '../lib/i18n'
import { useCurrentUser } from '../lib/session'

/**
 * Preview domain (Server). Previews need hosts of their own, so the admin names a domain whose
 * wildcard reaches this machine, and routes `pv-*` hosts to the preview listener.
 */
export function PreviewSettingsPage() {
  const t = useTranslate()
  const { data: me } = useCurrentUser()
  const { data: settings } = useAppSettings()
  const { data: previews } = usePreviews()
  const update = useUpdateAppSettings()
  const [domain, setDomain] = useState('')
  useEffect(() => { if (settings) setDomain(settings.previewDomain) }, [settings])

  if (me?.isAdmin !== true) {
    return <EmptyState icon={<ShieldCheck size={22} />} title={t('previewSettings.adminOnly.title')} description={t('previewSettings.adminOnly.description')} />
  }

  const dirty = settings !== undefined && domain.trim().toLowerCase() !== settings.previewDomain
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (dirty) update.mutate({ previewDomain: domain.trim().toLowerCase() })
  }
  const example = `${PREVIEW_HOST_PREFIX}3f9a1c2b7d4e.${settings?.previewDomain || domain.trim() || 'example.com'}`
  const port = previews?.listenerPort ?? 7318

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title={t('previewSettings.title')} description={t('previewSettings.description')} />
      <Card>
        <CardHeader title={t('previewSettings.domain.title')} icon={<MonitorPlay size={16} />} />
        <CardBody>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field
              label={t('previewSettings.domain.label')}
              hint={t('previewSettings.domain.hint', { example })}
              placeholder="example.com"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
            />
            {update.error instanceof ApiRequestError ? <Banner tone="critical">{update.error.message}</Banner> : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={!dirty || update.isPending}>{t('previewSettings.save')}</Button>
              {update.isSuccess && !dirty ? <span className="text-xs text-positive">{t('settings.saved')}</span> : null}
            </div>
          </form>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={t('previewSettings.proxy.title')} icon={<ShieldCheck size={16} />} />
        <CardBody className="flex flex-col gap-3 text-sm">
          <p className="text-ink-soft">{t('previewSettings.proxy.description', { port })}</p>
          <pre className="overflow-x-auto rounded-md bg-sunken p-3 font-mono text-xs">{`*.${settings?.previewDomain || 'example.com'} {
\t@preview header_regexp Host ^${PREVIEW_HOST_PREFIX}[a-f0-9]+\\.
\thandle @preview {
\t\treverse_proxy 127.0.0.1:${port}
\t}
}`}</pre>
          <p className="text-xs text-ink-faint">{t('previewSettings.proxy.isolation')}</p>
        </CardBody>
      </Card>
    </div>
  )
}
