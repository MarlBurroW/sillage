import { Archive, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Banner, Button, Card, CardBody, CardHeader, EmptyState, Field } from '../components/ui'
import { SectionHeader } from './SettingsPage'
import { ApiRequestError } from '../lib/api'
import { useAppSettings, useUpdateAppSettings } from '../lib/app-settings'
import { useTranslate } from '../lib/i18n'
import { useCurrentUser } from '../lib/session'

/**
 * Délai d'archivage automatique.
 *
 * Réglage d'instance et non de compte : il décide du sort de fils qui peuvent
 * appartenir à plusieurs personnes dans un projet partagé, et deux délais concurrents
 * n'auraient pas de gagnant lisible.
 */
export function ArchivingSettingsPage() {
  const t = useTranslate()
  const { data: me } = useCurrentUser()
  const isAdmin = me?.isAdmin === true
  const { data: settings } = useAppSettings()
  const update = useUpdateAppSettings()

  const [days, setDays] = useState('')
  // Le champ suit la valeur du serveur tant qu'on n'y a pas touché : sans ça il reste
  // vide au premier rendu, la requête n'ayant pas encore répondu.
  useEffect(() => {
    if (settings) setDays(String(settings.autoArchiveDays))
  }, [settings])

  if (!isAdmin) {
    return (
      <EmptyState
        icon={<ShieldCheck size={22} />}
        title={t('archiving.adminOnly.title')}
        description={t('archiving.adminOnly.description')}
      />
    )
  }

  const parsed = Number(days)
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 3650
  const dirty = settings !== undefined && parsed !== settings.autoArchiveDays

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (valid && dirty) update.mutate({ autoArchiveDays: parsed })
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t('archiving.section.title')}
        description={t('archiving.section.description')}
      />

      <Card>
        <CardHeader title={t('archiving.delay.title')} icon={<Archive size={16} />} />
        <CardBody>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field
              label={t('archiving.delay.label')}
              hint={parsed === 0 ? t('archiving.delay.disabled') : t('archiving.delay.hint')}
              error={valid ? undefined : t('archiving.delay.invalid')}
              type="number"
              min={0}
              max={3650}
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
            {update.error instanceof ApiRequestError ? (
              <Banner tone="critical">{update.error.message}</Banner>
            ) : null}
            <div>
              <Button type="submit" disabled={!valid || !dirty || update.isPending}>
                {t('archiving.delay.save')}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Banner tone="info">{t('archiving.criteria')}</Banner>
    </div>
  )
}
