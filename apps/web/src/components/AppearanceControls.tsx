import { RotateCcw } from 'lucide-react'
import { APPEARANCE_SETTINGS, type AppearanceKey, type useAppearance } from '../lib/appearance'
import { locale, useTranslate, type MessageKey } from '../lib/i18n'
import { Button, cx } from './ui'

const LABEL_KEYS: Record<AppearanceKey, { title: MessageKey; hint: MessageKey }> = {
  hue: { title: 'appearance.hue.title', hint: 'appearance.hue.hint' },
  tint: { title: 'appearance.tint.title', hint: 'appearance.tint.hint' },
  lift: { title: 'appearance.lift.title', hint: 'appearance.lift.hint' },
  conversationWidth: { title: 'appearance.conversationWidth.title', hint: 'appearance.conversationWidth.hint' },
  readingSize: { title: 'appearance.readingSize.title', hint: 'appearance.readingSize.hint' },
  readingLeading: {
    title: 'appearance.readingLeading.title',
    hint: 'appearance.readingLeading.hint',
  },
  readingSoftness: {
    title: 'appearance.readingSoftness.title',
    hint: 'appearance.readingSoftness.hint',
  },
  messageContrast: {
    title: 'appearance.messageContrast.title',
    hint: 'appearance.messageContrast.hint',
  },
}

/**
 * Fine theme controls: hue, intensity, lightness. Callers own hooks because the design page
 * displays resolved sRGB values and must redraw on slider movement, which internal component state
 * would not trigger.
 */
export function AppearanceControls({
  appearance,
  /** Visible sliders: themes do not react identically to every setting. */
  keys = ['hue', 'tint', 'lift'],
  swatches = true,
}: {
  appearance: ReturnType<typeof useAppearance>
  keys?: AppearanceKey[]
  /** Surface strips convey nothing about typography settings. */
  swatches?: boolean
}) {
  const { values, set, reset } = appearance
  const t = useTranslate()

  return (
    <div className="flex flex-col gap-4">
      {keys.map((name) => (
        <Slider
          key={name}
          name={name}
          value={values[name]}
          onChange={(value) => set(name, value)}
        />
      ))}

      {/*
       * Live preview follows html-applied sliders like the rest of the app. Show only for color
       * settings because surface strips reveal no typography changes.
       */}
      <div className="flex items-center gap-2">
        {swatches ? (
          <div className="flex flex-1 overflow-hidden rounded-md border border-line">
            <span className="h-8 flex-1 bg-canvas" />
            <span className="h-8 flex-1 bg-surface" />
            <span className="h-8 flex-1 bg-surface-high" />
            <span className="h-8 flex-1 bg-accent-wash" />
            <span className="gradient-accent h-8 flex-1" />
          </div>
        ) : (
          <span className="flex-1" />
        )}
        <Button variant="ghost" size="sm" icon={<RotateCcw size={14} />} onClick={() => reset(keys)}>
          {t('appearance.reset')}
        </Button>
      </div>
    </div>
  )
}

/**
 * Hue-wheel slider background matches real accent lightness/chroma for visual selection. Compute
 * stops once because CSS oklch gradients do not interpolate hue as needed; two-stop gradients would
 * cross gray rather than the spectrum.
 */
const HUE_STOPS = Array.from({ length: 13 }, (_, index) => {
  const hue = (index * 360) / 12
  return `oklch(0.62 0.19 ${hue}) ${(index * 100) / 12}%`
}).join(', ')

function Slider({
  name,
  value,
  onChange,
}: {
  name: AppearanceKey
  value: number
  onChange: (value: number) => void
}) {
  const setting = APPEARANCE_SETTINGS[name]
  const t = useTranslate()
  const title = t(LABEL_KEYS[name].title)
  const hint = t(LABEL_KEYS[name].hint)
  const spectrum = name === 'hue'
  const number = (input: number) => input.toLocaleString(locale(), { maximumFractionDigits: 2 })
  const display = spectrum ? `${number(value)}°`
    : name === 'conversationWidth' ? `${number(value)} px`
    : name === 'readingSize' ? `${number(value * 16)} px`
    : name === 'readingLeading' ? `${number(value)} ×`
    : `${value > 0 && name === 'lift' ? '+' : ''}${number(value * 100)} %`

  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between gap-3 text-sm font-medium text-ink-soft">
        <span className="min-w-0">
          {title} <span className="block text-xs font-normal text-ink-faint">{hint}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs text-ink">
          {spectrum ? (
            <span
              aria-hidden
              className="size-3 rounded-full border border-line"
              style={{ background: `oklch(0.62 0.19 ${value})` }}
            />
          ) : null}
          {display}
        </span>
      </span>
      <input
        type="range"
        aria-label={title}
        aria-valuetext={display}
        min={setting.min}
        max={setting.max}
        step={setting.step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className={cx('h-9 w-full', spectrum ? 'sg-hue-slider' : 'accent-[var(--sg-accent)]')}
        style={spectrum ? { background: `linear-gradient(90deg, ${HUE_STOPS})` } : undefined}
      />
    </label>
  )
}
