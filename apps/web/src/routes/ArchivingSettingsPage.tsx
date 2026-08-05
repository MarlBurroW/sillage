import { Archive, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Banner, Button, Card, CardBody, CardHeader, EmptyState, Field, cx } from '../components/ui'
import { SectionHeader } from './SettingsPage'
import { ApiRequestError } from '../lib/api'
import { useAppSettings, useUpdateAppSettings } from '../lib/app-settings'
import { cronNextRuns, cronToHuman } from '../lib/cron'
import { locale, useTranslate, type MessageKey } from '../lib/i18n'
import { useCurrentUser } from '../lib/session'

/**
 * Délai d'archivage automatique et heure de passage.
 *
 * Réglage d'instance et non de compte : il décide du sort de fils qui peuvent
 * appartenir à plusieurs personnes dans un projet partagé, et deux délais concurrents
 * n'auraient pas de gagnant lisible.
 */

const PRESETS: { labelKey: MessageKey; schedule: string }[] = [
  { labelKey: 'archiving.preset.hourly', schedule: '0 * * * *' },
  { labelKey: 'archiving.preset.earlyMorning', schedule: '45 4 * * *' },
  { labelKey: 'archiving.preset.midday', schedule: '0 12 * * *' },
  { labelKey: 'archiving.preset.weekly', schedule: '45 4 * * 1' },
]

export function ArchivingSettingsPage() {
  const t = useTranslate()
  const { data: me } = useCurrentUser()
  const isAdmin = me?.isAdmin === true
  const { data: settings } = useAppSettings()
  const update = useUpdateAppSettings()

  const [days, setDays] = useState('')
  const [schedule, setSchedule] = useState('')
  // Les champs suivent la valeur du serveur tant qu'on n'y a pas touché : sans ça ils
  // restent vides au premier rendu, la requête n'ayant pas encore répondu.
  useEffect(() => {
    if (!settings) return
    setDays(String(settings.autoArchiveDays))
    setSchedule(settings.autoArchiveSchedule)
  }, [settings])

  const human = useMemo(() => cronToHuman(schedule, locale()), [schedule])
  const nextRuns = useMemo(() => (human ? cronNextRuns(schedule, 3) : []), [human, schedule])

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
  const daysValid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 3650
  const dirty =
    settings !== undefined &&
    (parsed !== settings.autoArchiveDays || schedule !== settings.autoArchiveSchedule)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (daysValid && human && dirty) {
      update.mutate({ autoArchiveDays: parsed, autoArchiveSchedule: schedule })
    }
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
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field
              label={t('archiving.delay.label')}
              hint={parsed === 0 ? t('archiving.delay.disabled') : undefined}
              error={daysValid ? undefined : t('archiving.delay.invalid')}
              type="number"
              min={0}
              max={3650}
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />

            <div className="flex flex-col gap-2">
              <Field
                label={t('archiving.schedule.label')}
                error={human ? undefined : t('archiving.schedule.invalid')}
                value={schedule}
                spellCheck={false}
                onChange={(event) => setSchedule(event.target.value)}
              />

              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.schedule}
                    type="button"
                    onClick={() => setSchedule(preset.schedule)}
                    className={cx(
                      'rounded-md border px-2 py-0.5 text-xs transition-colors',
                      preset.schedule === schedule
                        ? 'border-accent bg-accent-wash text-ink'
                        : 'border-line text-ink-faint hover:border-line-strong hover:text-ink-soft',
                    )}
                  >
                    {t(preset.labelKey)}
                  </button>
                ))}
              </div>

              {/* L'aperçu est calculé dans le navigateur : le dire évite qu'un décalage
                  avec le serveur passe pour un bug de l'archivage. */}
              {human ? (
                <p className="text-xs text-ink-faint">
                  <span className="text-ink-soft">{human}</span>
                  {nextRuns.length > 0
                    ? ` ${t('archiving.schedule.nextRuns', {
                        runs: nextRuns
                          .map((date) =>
                            date.toLocaleString(locale(), {
                              weekday: 'short',
                              day: 'numeric',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                            }),
                          )
                          .join(', '),
                      })}`
                    : null}
                </p>
              ) : null}
            </div>

            {update.error instanceof ApiRequestError ? (
              <Banner tone="critical">{update.error.message}</Banner>
            ) : null}

            <div>
              <Button type="submit" disabled={!daysValid || !human || !dirty || update.isPending}>
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
