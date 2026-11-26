import { BookOpen, CircleCheck, MonitorPlay, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { PREVIEW_HOST_PREFIX } from '@sillage/protocol'
import { Banner, Button, Card, CardBody, CardHeader, EmptyState, Field } from '../components/ui'
import { SectionHeader } from './SettingsPage'
import { ApiRequestError } from '../lib/api'
import { useAppSettings, useUpdateAppSettings } from '../lib/app-settings'
import { PREVIEWS_DOCS_URL, useCheckPreviews, usePreviews } from '../lib/previews'
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
  const check = useCheckPreviews()
  const [domain, setDomain] = useState('')
  useEffect(() => { if (settings) setDomain(settings.previewDomain) }, [settings])
  // Checked on opening and after each save, so the page always says whether previews work.
  const saved = settings?.previewDomain ?? ''
  useEffect(() => {
    if (saved && me?.isAdmin) check.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, me?.isAdmin])

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
      <a href={PREVIEWS_DOCS_URL} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1.5 text-sm text-accent underline-offset-2 hover:underline">
        <BookOpen size={15} />{t('previewSettings.docs')}
      </a>
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
      {saved ? (
        <Card>
          <CardHeader title={t('previewSettings.check.title')} icon={<RefreshCw size={16} />} />
          <CardBody className="flex flex-col gap-3 text-sm">
            {check.data ? (
              <div data-preview-check={check.data.status} className={`flex items-start gap-2 ${check.data.status === 'ok' ? 'text-positive' : 'text-caution'}`}>
                {check.data.status === 'ok' ? <CircleCheck size={16} className="mt-0.5 shrink-0" /> : <TriangleAlert size={16} className="mt-0.5 shrink-0" />}
                <div className="min-w-0">
                  <p className="font-medium">{t(`previewSettings.check.${check.data.status}`)}</p>
                  {check.data.status !== 'ok' ? <p className="text-ink-soft">{t(`previewSettings.check.${check.data.status}.fix`, { port: previews?.listenerPort ?? 7318, domain: saved })}</p> : null}
                  {check.data.url ? <p className="mt-1 break-all font-mono text-[11px] text-ink-faint">{check.data.url}{check.data.detail ? ` · ${check.data.detail}` : ''}</p> : null}
                </div>
              </div>
            ) : check.isPending ? <p className="text-ink-faint">{t('previewSettings.check.running')}</p> : null}
            {check.error instanceof ApiRequestError ? <Banner tone="critical">{check.error.message}</Banner> : null}
            <div><Button variant="ghost" icon={<RefreshCw size={14} />} disabled={check.isPending} onClick={() => check.mutate()}>{t('previewSettings.check.run')}</Button></div>
          </CardBody>
        </Card>
      ) : null}
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
          <p className="text-xs text-ink-faint">{t('previewSettings.proxy.more')}</p>
        </CardBody>
      </Card>
    </div>
  )
}
