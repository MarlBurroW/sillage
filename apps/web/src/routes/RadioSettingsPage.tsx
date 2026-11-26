import { Radio } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { MAX_RADIO_URL_CHARS, youtubeVideoId } from '@sillage/protocol'
import { Banner, Button, Card, CardBody, CardHeader, Field } from '../components/ui'
import { ApiRequestError } from '../lib/api'
import { useTranslate } from '../lib/i18n'
import { useRadioStation, useUpdateRadioUrl } from '../lib/radio'
import { useUserSettings } from '../lib/user-settings'
import { SectionHeader } from './SettingsPage'

/** The station of the rail's radio: Claude FM by default, any YouTube video or live otherwise. */
export function RadioSettingsPage() {
  const t = useTranslate()
  const { data: settings } = useUserSettings()
  const { data: station } = useRadioStation()
  const update = useUpdateRadioUrl()
  const stored = settings?.radioUrl ?? ''
  const [url, setUrl] = useState('')
  // Follow the server until edited: otherwise the field is empty while settings load.
  useEffect(() => { setUrl(stored) }, [stored])

  // Named after the saved link only once the station follows it, not from the previous answer.
  const stationName = !stored ? 'Claude FM' : station?.custom && station.link === stored ? (station.title ?? t('radio.settings.untitled')) : '…'
  const next = url.trim()
  const valid = next === '' || youtubeVideoId(next) !== null
  const dirty = settings !== undefined && next !== stored
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (valid && dirty) update.mutate(next || null)
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title={t('radio.settings.title')} description={t('radio.settings.description')} />
      <Card>
        <CardHeader title={stationName} icon={<Radio size={16} />} />
        <CardBody>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field
              label={t('radio.settings.url')}
              hint={t('radio.settings.url.hint')}
              error={valid ? undefined : t('radio.settings.url.invalid')}
              type="url"
              inputMode="url"
              placeholder="https://www.youtube.com/watch?v=…"
              maxLength={MAX_RADIO_URL_CHARS}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              data-radio-url
            />
            {update.error instanceof ApiRequestError ? <Banner tone="critical">{update.error.message}</Banner> : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={!valid || !dirty || update.isPending}>{t('radio.settings.save')}</Button>
              {stored ? (
                <Button type="button" variant="ghost" disabled={update.isPending} onClick={() => update.mutate(null)}>{t('radio.settings.reset')}</Button>
              ) : null}
              {update.isSuccess && !dirty ? <span className="text-xs text-ink-faint">{t('radio.settings.saved')}</span> : null}
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  )
}
