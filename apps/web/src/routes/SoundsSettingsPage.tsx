import { Play, Upload, Volume2, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { Banner, Button, Card, CardBody, CardHeader, IconButton, Select, Switch, type SelectOption } from '../components/ui'
import { useTranslate, type MessageKey } from '../lib/i18n'
import {
  SOUND_EVENTS,
  SOUND_PRESETS,
  playSound,
  removeCustomSound,
  saveCustomSound,
  setSoundPrefs,
  useCustomSound,
  useSoundPrefs,
  type SoundChoice,
  type SoundEvent,
} from '../lib/sounds'
import { SectionHeader } from './SettingsPage'

/** Sounds of this device. Applied as they change: each choice is tried by ear right away. */
export function SoundsSettingsPage() {
  const t = useTranslate()
  const prefs = useSoundPrefs()
  const percent = Math.round(prefs.volume * 100)

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title={t('sounds.title')} description={t('sounds.description')} />
      <Card>
        <CardHeader
          title={t('sounds.enabled')}
          description={t('sounds.enabled.hint')}
          icon={<Volume2 size={16} />}
          actions={<Switch checked={prefs.enabled} onCheckedChange={(enabled) => setSoundPrefs({ enabled })} label={t('sounds.enabled')} />}
        />
        <CardBody className="flex flex-col gap-5">
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center justify-between text-sm font-medium text-ink-soft">
              {t('sounds.volume')}
              <span className="text-xs font-normal text-ink-faint tabular-nums">{percent} %</span>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={percent}
              aria-valuetext={`${percent} %`}
              onChange={(event) => setSoundPrefs({ volume: Number(event.target.value) / 100 })}
              className="h-9 w-full accent-[var(--sg-accent)]"
            />
          </label>
          {SOUND_EVENTS.map((event) => <EventRow key={event} event={event} />)}
        </CardBody>
      </Card>
    </div>
  )
}

const EVENT_LABEL: Record<SoundEvent, MessageKey> = { done: 'sounds.event.done', attention: 'sounds.event.attention', problem: 'sounds.event.problem' }
const EVENT_HINT: Record<SoundEvent, MessageKey> = { done: 'sounds.event.done.hint', attention: 'sounds.event.attention.hint', problem: 'sounds.event.problem.hint' }
const PRESET_LABEL: Record<(typeof SOUND_PRESETS)[number], MessageKey> = {
  chime: 'sounds.preset.chime',
  bell: 'sounds.preset.bell',
  pop: 'sounds.preset.pop',
  twoTone: 'sounds.preset.twoTone',
  descend: 'sounds.preset.descend',
}

function EventRow({ event }: { event: SoundEvent }) {
  const t = useTranslate()
  const prefs = useSoundPrefs()
  const custom = useCustomSound(event)
  const file = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const choice = prefs.choices[event]

  const options: SelectOption<SoundChoice>[] = [
    { value: 'off', label: t('sounds.choice.off') },
    ...SOUND_PRESETS.map((preset) => ({ value: preset, label: t(PRESET_LABEL[preset]) })),
    { value: 'custom', label: custom ? t('sounds.choice.customNamed', { name: custom.name }) : t('sounds.choice.custom') },
  ]

  const choose = (next: SoundChoice) => {
    setError(null)
    // Without a file yet, choosing one opens the picker; the choice lands once it is kept.
    if (next === 'custom' && !custom) {
      file.current?.click()
      return
    }
    setSoundPrefs({ choices: { ...prefs.choices, [event]: next } })
    playSound(event, next)
  }

  const upload = async (picked: File | undefined) => {
    if (!picked) return
    setError(null)
    try {
      await saveCustomSound(event, picked)
      playSound(event, 'custom')
    } catch (err) {
      const key = err instanceof Error ? err.message : ''
      setError(key.startsWith('sounds.custom.') ? t(key as MessageKey) : t('sounds.custom.readFailed'))
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4 first-of-type:border-t-0 first-of-type:pt-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{t(EVENT_LABEL[event])}</p>
        <p className="text-xs text-ink-faint">{t(EVENT_HINT[event])}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={choice} onChange={choose} options={options} label={undefined} className="w-56 max-w-full" placeholder={t(EVENT_LABEL[event])} />
        <IconButton label={t('sounds.test')} disabled={choice === 'off'} onClick={() => playSound(event)}>
          <Play size={15} />
        </IconButton>
        <Button type="button" variant="ghost" size="sm" onClick={() => file.current?.click()}>
          <Upload size={14} />
          {custom ? t('sounds.custom.replace') : t('sounds.custom.pick')}
        </Button>
        {custom ? (
          <IconButton label={t('sounds.custom.remove', { name: custom.name })} size="sm" onClick={() => removeCustomSound(event)}>
            <X size={14} />
          </IconButton>
        ) : null}
        <input
          ref={file}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(change) => {
            void upload(change.target.files?.[0])
            change.target.value = ''
          }}
        />
      </div>
      {error ? <Banner tone="critical">{error}</Banner> : null}
    </div>
  )
}
