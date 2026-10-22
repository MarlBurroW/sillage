import { Cpu, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Banner, Button, Card, CardBody, CardHeader, EmptyState, Field } from '../components/ui'
import { SectionHeader } from './SettingsPage'
import { ApiRequestError } from '../lib/api'
import { useAppSettings, useUpdateAppSettings } from '../lib/app-settings'
import { useTranslate } from '../lib/i18n'
import { useCurrentUser } from '../lib/session'

/**
 * Maximum simultaneous CLI sessions.
 *
 * Instance setting protecting machine memory shared by all accounts. `config.toml` is only the
 * initial value; this screen writes to the database.
 */
export function SessionsSettingsPage() {
  const t = useTranslate()
  const { data: me } = useCurrentUser()
  const isAdmin = me?.isAdmin === true
  const { data: settings } = useAppSettings()
  const update = useUpdateAppSettings()

  const [limit, setLimit] = useState('')
  // The field follows the server until edited; otherwise it stays empty on first
  // render before the request returns.
  useEffect(() => {
    if (!settings) return
    setLimit(String(settings.maxConcurrentSessions))
  }, [settings])

  if (!isAdmin) {
    return (
      <EmptyState
        icon={<ShieldCheck size={22} />}
        title={t('sessions.adminOnly.title')}
        description={t('sessions.adminOnly.description')}
      />
    )
  }

  const parsed = Number(limit)
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 100
  const dirty = settings !== undefined && parsed !== settings.maxConcurrentSessions

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (valid && dirty) update.mutate({ maxConcurrentSessions: parsed })
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t('sessions.section.title')}
        description={t('sessions.section.description')}
      />

      <Card>
        <CardHeader title={t('sessions.limit.title')} icon={<Cpu size={16} />} />
        <CardBody>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field
              label={t('sessions.limit.label')}
              hint={t('sessions.limit.hint')}
              error={valid ? undefined : t('sessions.limit.invalid')}
              type="number"
              min={1}
              max={100}
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
            />

            {update.error instanceof ApiRequestError ? (
              <Banner tone="critical">{update.error.message}</Banner>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={!valid || !dirty || update.isPending}>
                {t('sessions.limit.save')}
              </Button>
              {/*
               * A disabled button does not prove success: it also disables when restoring the
               * original value.
               */}
              {update.isSuccess && !dirty ? (
                <span className="text-xs text-positive">{t('settings.saved')}</span>
              ) : null}
            </div>
          </form>
        </CardBody>
      </Card>

      <Banner tone="info">{t('sessions.limit.eviction')}</Banner>
    </div>
  )
}
