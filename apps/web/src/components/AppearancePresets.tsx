import { useTranslate } from '../lib/i18n'
import type { useAppearance } from '../lib/appearance'
import type { Theme } from '../lib/theme'
import { cx } from './ui'

const PRESETS = [
  { name: 'sillage', tint: 1 },
  { name: 'soft', tint: 0.25 },
  { name: 'neutral', tint: 0 },
] as const

/** Seule la dose de couleur change : la teinte et le confort de lecture restent personnels. */
export function AppearancePresets({ appearance, theme }: {
  appearance: ReturnType<typeof useAppearance>
  theme: Theme
}) {
  const t = useTranslate()
  const light = theme === 'light'
  const hue = appearance.values.hue
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium text-ink-soft">{t('appearance.presets.title')}</legend>
      <div className="grid grid-cols-3 gap-2">
        {PRESETS.map(({ name, tint }) => {
          const selected = appearance.values.tint === tint
          return (
            <label key={name} className={cx(
              'min-w-0 cursor-pointer rounded-lg border p-2 has-focus-visible:ring-2 has-focus-visible:ring-accent',
              selected ? 'border-accent bg-accent-wash' : 'border-line hover:border-line-strong',
            )}>
              <span aria-hidden className="mb-2 flex h-12 gap-1 overflow-hidden rounded p-1.5" style={{ background: `oklch(${light ? 0.975 : 0.168} ${(light ? 0.016 : 0.055) * tint} ${hue})` }}>
                <span className="w-1/4 rounded" style={{ background: `oklch(${light ? 0.945 : 0.262} ${(light ? 0.026 : 0.072) * tint} ${hue})` }} />
                <span className="flex flex-1 flex-col justify-center gap-1">
                  <span className="h-1.5 w-3/4 rounded" style={{ background: `oklch(${light ? 0.54 : 0.71} 0.17 ${hue})` }} />
                  <span className="h-1.5 rounded" style={{ background: `oklch(${light ? 0.8 : 0.42} ${(light ? 0.05 : 0.09) * tint} ${hue})` }} />
                </span>
              </span>
              <span className="flex items-center justify-center gap-1.5 text-xs font-medium text-ink">
                <input type="radio" name="appearance-preset" checked={selected} onChange={() => appearance.set('tint', tint)} className="size-3 shrink-0 accent-[var(--sg-accent)]" />
                {t(`appearance.presets.${name}`)}
              </span>
            </label>
          )
        })}
      </div>
      <p className="mt-2 text-xs text-ink-faint">{t('appearance.presets.hint')}</p>
    </fieldset>
  )
}
