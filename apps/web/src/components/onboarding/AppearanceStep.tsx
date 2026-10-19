import { Contrast, Moon, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import { useAppearance } from '../../lib/appearance'
import { useTranslate } from '../../lib/i18n'
import { THEMES, THEME_LABELS, useTheme, type Theme } from '../../lib/theme'
import { AppearanceControls } from '../AppearanceControls'
import { AppearancePresets } from '../AppearancePresets'
import { ReadingPreview } from '../ReadingPreview'
import { cx } from '../ui'
import { Question, StepTitle, Tip, useCommit, useGate, type StepProps } from './shell'

const THEME_ICONS: Record<Theme, ReactNode> = {
  light: <Sun size={15} />,
  dark: <Moon size={15} />,
  'dark-contrast': <Contrast size={15} />,
}

/**
 * Apparence : les mêmes réglages que Réglages › Apparence, appliqués en direct sur
 * `<html>` et enregistrés au compte par la synchronisation montée sur la page. Rien à
 * valider : ce que l'on voit est déjà ce qui est retenu.
 */
export function AppearanceStep({ nav }: StepProps) {
  const t = useTranslate()
  const [theme, setTheme] = useTheme()
  const appearance = useAppearance()

  useGate(nav, { canContinue: true, laterAllowed: true, skipAllowed: true })
  useCommit(nav, null)

  return (
    <>
      <StepTitle title={t('onboarding.appearance.title')} lead={t('onboarding.appearance.lead')} />

      <Question label={t('onboarding.appearance.theme')}>
        <div className="grid grid-cols-3 gap-2">
          {THEMES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setTheme(option)}
              aria-pressed={theme === option}
              className={cx(
                'flex flex-col items-center gap-2 rounded-md border px-3 py-3 transition-colors',
                theme === option ? 'border-accent bg-accent-wash text-ink' : 'border-line text-ink-soft hover:border-line-strong hover:text-ink',
              )}
            >
              {THEME_ICONS[option]}
              <span className="text-xs font-medium">{t(THEME_LABELS[option])}</span>
            </button>
          ))}
        </div>
      </Question>

      {/* Le thème contrasté est neutre par construction : teinte et ambiance n'y
          changeraient rien. */}
      {theme === 'dark-contrast' ? null : (
        <>
          <AppearancePresets appearance={appearance} theme={theme} />
          <Question label={t('onboarding.appearance.hue')} hint={t('onboarding.appearance.hue.hint')}>
            <AppearanceControls appearance={appearance} keys={['hue']} swatches={false} />
          </Question>
        </>
      )}

      <Question label={t('onboarding.appearance.reading')} hint={t('onboarding.appearance.reading.hint')}>
        <AppearanceControls appearance={appearance} keys={['readingSize']} swatches={false} />
        <ReadingPreview />
      </Question>

      <Tip>{t('onboarding.appearance.more')}</Tip>
    </>
  )
}
