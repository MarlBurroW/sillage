import { Cpu, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Banner, Button, Card, CardBody, CardHeader, EmptyState, Field } from '../components/ui'
import { SectionHeader } from './SettingsPage'
import { ApiRequestError } from '../lib/api'
import { useAppSettings, useUpdateAppSettings } from '../lib/app-settings'
import { useTranslate } from '../lib/i18n'
import { useCurrentUser } from '../lib/session'

/**
 * Plafond de sessions CLI simultanées.
 *
 * Réglage d'instance : ce qu'il protège est la mémoire de la machine, partagée par
 * tous les comptes. La valeur du `config.toml` ne sert plus que de point de départ,
 * l'écran écrivant en base.
 */
export function SessionsSettingsPage() {
  const t = useTranslate()
  const { data: me } = useCurrentUser()
  const isAdmin = me?.isAdmin === true
  const { data: settings } = useAppSettings()
  const update = useUpdateAppSettings()

  const [limit, setLimit] = useState('')
  // Le champ suit le serveur tant qu'on n'y a pas touché : sans ça il reste vide au
  // premier rendu, la requête n'ayant pas encore répondu.
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

            <div>
              <Button type="submit" disabled={!valid || !dirty || update.isPending}>
                {t('sessions.limit.save')}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Banner tone="info">{t('sessions.limit.eviction')}</Banner>
    </div>
  )
}
