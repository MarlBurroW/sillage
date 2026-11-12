import { TimerReset } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { DEFAULT_USAGE_LIMIT_RESUME_MESSAGE, MAX_USAGE_LIMIT_RESUME_HOURS, MAX_USAGE_LIMIT_RESUME_MESSAGE_CHARS } from '@sillage/protocol'
import { Banner, Button, Card, CardBody, CardHeader, Field } from '../components/ui'
import { ApiRequestError } from '../lib/api'
import { useTranslate } from '../lib/i18n'
import { useUpdateUsageLimitResume, useUserSettings } from '../lib/user-settings'
import { SectionHeader } from './SettingsPage'

/**
 * Resuming sessions a subscription limit stopped mid-turn.
 *
 * Account-level: the resumed work spends this account's quota. A saved form rather than live
 * switches because the three fields describe one behavior and are read together.
 */
export function UsageLimitsSettingsPage() {
  const t = useTranslate()
  const { data: settings } = useUserSettings()
  const update = useUpdateUsageLimitResume()

  const [enabled, setEnabled] = useState(false)
  const [hours, setHours] = useState('')
  const [message, setMessage] = useState('')
  // Follow the server until edited, like the session limit: otherwise the form is empty while the
  // settings load.
  useEffect(() => {
    if (!settings) return
    setEnabled(settings.usageLimitResume.enabled)
    setHours(String(settings.usageLimitResume.maxHours))
    setMessage(settings.usageLimitResume.message)
  }, [settings])

  const parsedHours = Number(hours.replace(',', '.'))
  const hoursValid = Number.isFinite(parsedHours) && parsedHours >= 0.25 && parsedHours <= MAX_USAGE_LIMIT_RESUME_HOURS
  const messageValid = message.length <= MAX_USAGE_LIMIT_RESUME_MESSAGE_CHARS
  const stored = settings?.usageLimitResume
  const dirty = stored !== undefined && (enabled !== stored.enabled || parsedHours !== stored.maxHours || message !== stored.message)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (hoursValid && messageValid && dirty) update.mutate({ enabled, maxHours: parsedHours, message })
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title={t('usageLimits.section.title')} description={t('usageLimits.section.description')} />

      <Card>
        <CardHeader title={t('usageLimits.resume.title')} icon={<TimerReset size={16} />} />
        <CardBody>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0 accent-accent"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-ink">{t('usageLimits.resume.enabled')}</span>
                <span className="text-xs text-ink-faint">{t('usageLimits.resume.enabled.hint')}</span>
              </span>
            </label>

            <Field
              label={t('usageLimits.resume.maxHours')}
              hint={t('usageLimits.resume.maxHours.hint')}
              error={hoursValid ? undefined : t('usageLimits.resume.maxHours.invalid', { max: MAX_USAGE_LIMIT_RESUME_HOURS })}
              type="number"
              inputMode="decimal"
              min={0.25}
              max={MAX_USAGE_LIMIT_RESUME_HOURS}
              step={0.25}
              value={hours}
              disabled={!enabled}
              onChange={(event) => setHours(event.target.value)}
            />

            <div className="flex flex-col gap-1.5">
              <label htmlFor="usage-limit-message" className="text-sm font-medium text-ink-soft">
                {t('usageLimits.resume.message')}
              </label>
              <textarea
                id="usage-limit-message"
                rows={4}
                value={message}
                disabled={!enabled}
                placeholder={DEFAULT_USAGE_LIMIT_RESUME_MESSAGE}
                maxLength={MAX_USAGE_LIMIT_RESUME_MESSAGE_CHARS}
                onChange={(event) => setMessage(event.target.value)}
                className="rounded-md border border-line bg-sunken px-3 py-2 text-sm text-ink outline-none transition-colors hover:border-line-strong focus:border-accent disabled:opacity-60"
              />
              <p className="text-xs text-ink-faint">{t('usageLimits.resume.message.hint')}</p>
            </div>

            {update.error instanceof ApiRequestError ? <Banner tone="critical">{update.error.message}</Banner> : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={!hoursValid || !messageValid || !dirty || update.isPending}>
                {t('usageLimits.resume.save')}
              </Button>
              {update.isSuccess && !dirty ? <span className="text-xs text-ink-faint">{t('usageLimits.resume.saved')}</span> : null}
            </div>
          </form>
        </CardBody>
      </Card>

      <p className="text-xs text-ink-faint">{t('usageLimits.notify.hint')}</p>
    </div>
  )
}
