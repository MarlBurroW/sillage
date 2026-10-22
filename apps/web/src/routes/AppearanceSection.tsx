import { ToolStyleControls } from '../components/ToolStyleControls'
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
  // Language whose catalog is still downloading: switch only once it arrives,
  // and show waiting state rather than seeming to ignore the click.
  const pending = usePendingLocale()
  const t = useTranslate()

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t('settings.appearance.title')}
        description={t('settings.appearance.description')}
      />

      {/*
       * Language before theme: it determines readability of the rest of the screen, including
       * this page's labels.
       */}
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
                  // Failure leaves the UI intact in its current language: nothing needs repairing;
                  // another click retries.
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
                {/*
                 * Each language names itself: users look for “Français” even in an English
                 * interface.
                 */}
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

          {/*
           * The contrast theme is neutral by design: hue and intensity do nothing; only
           * brightness has an effect.
           */}
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

      {/* Width and typography share reading-comfort settings. */}
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

      <Card>
        <CardHeader title={t('toolStyle.title')} description={t('toolStyle.description')} icon={<Logo size={16} />} />
        <CardBody><ToolStyleControls /></CardBody>
      </Card>

      {/*
       * The code palette affects only code; mixing it with surface settings would imply
       * otherwise.
       */}
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
