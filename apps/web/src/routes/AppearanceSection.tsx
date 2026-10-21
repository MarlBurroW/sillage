import { Code, Contrast, Languages, Loader, Moon, Palette, Sun, TextQuote } from 'lucide-react'
import type { ReactNode } from 'react'
import { AppearanceControls } from '../components/AppearanceControls'
import { AppearancePresets } from '../components/AppearancePresets'
import { ReadingPreview } from '../components/ReadingPreview'
import { SyntaxThemeControls } from '../components/SyntaxThemeControls'
import { TypingIndicatorControls } from '../components/TypingIndicatorControls'
import { Logo } from '../components/Logo'
import { useAppearance } from '../lib/appearance'
import { LOCALES, LOCALE_LABELS, setLocale, useLocale, usePendingLocale, useTranslate } from '../lib/i18n'
import { THEMES, THEME_LABELS, useTheme, type Theme } from '../lib/theme'
import { Card, CardBody, CardHeader, cx } from '../components/ui'
import { SectionHeader } from './SettingsPage'

const THEME_ICONS: Record<Theme, ReactNode> = {
  light: <Sun size={15} />,
  dark: <Moon size={15} />,
  'dark-contrast': <Contrast size={15} />,
}

export function AppearanceSection() {
  const [theme, setTheme] = useTheme()
  const appearance = useAppearance()
  const active = useLocale()
  // Langue dont le catalogue se télécharge encore : l'interface ne bascule qu'une fois
  // qu'il est là, et le bouton montre l'attente plutôt que de sembler ignorer le clic.
  const pending = usePendingLocale()
  const t = useTranslate()

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t('settings.appearance.title')}
        description={t('settings.appearance.description')}
      />

      {/* La langue avant le thème : c'est le réglage qui décide de la lisibilité du
          reste de l'écran, y compris des libellés de cette page. */}
      <Card>
        <CardHeader
          title={t('settings.language.title')}
          description={t('settings.language.description')}
          icon={<Languages size={16} />}
        />
        <CardBody>
          <div className="grid grid-cols-2 gap-2">
            {LOCALES.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  // Un échec laisse l'interface dans sa langue, entière : rien à réparer
                  // à l'écran, un nouveau clic retentera.
                  setLocale(option).catch((error: unknown) => console.warn(error))
                }}
                aria-pressed={active === option}
                aria-busy={pending === option}
                className={cx(
                  'flex items-center justify-center gap-2 rounded-md border px-3 py-2.5 text-sm font-medium transition-colors',
                  active === option
                    ? 'border-accent bg-accent-wash text-ink'
                    : 'border-line text-ink-soft hover:border-line-strong hover:text-ink',
                )}
              >
                {/* Chaque langue dans la sienne : on cherche « Français » même quand
                    l'interface est en anglais. */}
                {pending === option ? <Loader size={14} className="animate-spin" aria-hidden /> : null}
                {LOCALE_LABELS[option]}
              </button>
            ))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={t('settings.theme.title')}
          description={t('settings.theme.description')}
          icon={<Palette size={16} />}
        />
        <CardBody className="flex flex-col gap-5">
          <div className="grid grid-cols-3 gap-2">
            {THEMES.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setTheme(option)}
                aria-pressed={theme === option}
                className={cx(
                  'flex flex-col items-center gap-2 rounded-md border px-3 py-3 transition-colors',
                  theme === option
                    ? 'border-accent bg-accent-wash text-ink'
                    : 'border-line text-ink-soft hover:border-line-strong hover:text-ink',
                )}
              >
                {THEME_ICONS[option]}
                <span className="text-xs font-medium">{t(THEME_LABELS[option])}</span>
              </button>
            ))}
          </div>

          {/* Le thème contrasté est neutre par construction : teinte et intensité
              n'y produiraient rien, seule la luminosité a un effet. */}
          {theme === 'dark-contrast' ? <AppearanceControls appearance={appearance} keys={['lift']} /> : (
            <>
              <AppearancePresets appearance={appearance} theme={theme} />
              <details className="border-t border-line pt-2">
                <summary className="cursor-pointer py-2 text-sm font-medium text-ink-soft">{t('appearance.advanced')}</summary>
                <div className="pt-3"><AppearanceControls appearance={appearance} /></div>
              </details>
            </>
          )}
        </CardBody>
      </Card>

      {/* La largeur et la typographie partagent les réglages de confort de lecture. */}
      <Card>
        <CardHeader
          title={t('settings.reading.title')}
          description={t('settings.reading.description')}
          icon={<TextQuote size={16} />}
        />
        <CardBody className="flex flex-col gap-5">
          <AppearanceControls
            appearance={appearance}
            keys={['conversationWidth', 'readingSize', 'readingLeading', 'readingSoftness', 'messageContrast']}
            swatches={false}
          />
          <ReadingPreview />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={t('settings.typingIndicator.title')}
          description={t('settings.typingIndicator.description')}
          icon={<Logo size={16} />}
        />
        <CardBody>
          <TypingIndicatorControls />
        </CardBody>
      </Card>

      {/* La palette de code ne touche à rien d'autre que le code, et la mélanger aux
          réglages de surfaces laisserait croire l'inverse. */}
      <Card>
        <CardHeader
          title={t('settings.syntax.title')}
          description={t('settings.syntax.description')}
          icon={<Code size={16} />}
        />
        <CardBody>
          <SyntaxThemeControls />
        </CardBody>
      </Card>
    </div>
  )
}
