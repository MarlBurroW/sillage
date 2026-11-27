import { Check } from 'lucide-react'
import { useEffect } from 'react'
import { FONT_OPTIONS, SYSTEM_FONT, loadFont, previewFamily, useFonts, type FontSlot } from '../lib/fonts'
import { useTranslate } from '../lib/i18n'
import { cx } from './ui'

const SAMPLES: Record<FontSlot, string> = {
  sans: 'Aa Bb 123',
  mono: '{ 0O 1lI }',
}

/**
 * One card per family, drawn in that family so the choice is made by eye. The previews download
 * every family of the slot (Latin files run 20–50 KB each), so they wait for `active`: Appearance
 * keeps hidden tabs mounted and opening the settings must not fetch them.
 */
export function FontControls({ slot, active }: { slot: FontSlot; active: boolean }) {
  const t = useTranslate()
  const [fonts, setFont] = useFonts()

  useEffect(() => {
    if (!active) return
    for (const option of FONT_OPTIONS[slot]) void loadFont(slot, option.id)
  }, [active, slot])

  const options = [{ id: SYSTEM_FONT, label: t('fonts.system') }, ...FONT_OPTIONS[slot].map((option) => ({
    id: option.id,
    // Fontsource names end in "Variable": an implementation detail, not part of the family's name.
    label: option.label ?? option.family.replace(/ Variable$/, ''),
  }))]

  return (
    <div className="@container flex flex-col gap-3">
      <div role="group" aria-label={t(`fonts.${slot}.title`)} className="grid grid-cols-2 gap-2 @min-[26rem]:grid-cols-3 @min-[40rem]:grid-cols-4">
        {options.map(({ id, label }) => {
          const selected = fonts[slot] === id
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected}
              onClick={() => setFont(slot, id)}
              className={cx(
                'flex min-w-0 flex-col items-stretch gap-1 rounded-md border px-2.5 py-2 text-left transition-colors',
                selected ? 'border-accent bg-accent-wash text-ink' : 'border-line text-ink-soft hover:border-line-strong hover:text-ink',
              )}
            >
              <span className="flex items-center justify-between gap-1">
                <span aria-hidden className="truncate text-lg leading-7 text-ink" style={{ fontFamily: previewFamily(slot, id) }}>
                  {SAMPLES[slot]}
                </span>
                <Check size={13} aria-hidden className={cx('shrink-0 text-accent', !selected && 'invisible')} />
              </span>
              <span className="truncate text-xs font-medium" style={{ fontFamily: previewFamily(slot, id) }}>{label}</span>
              {id === SYSTEM_FONT ? <span className="text-[0.625rem] text-ink-faint">{t('fonts.default')}</span> : null}
            </button>
          )
        })}
      </div>
      <p className="text-xs text-ink-faint">{t(`fonts.${slot}.hint`)}</p>
    </div>
  )
}
