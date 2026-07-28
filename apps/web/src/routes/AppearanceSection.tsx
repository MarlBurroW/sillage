import { Code, Contrast, Moon, Palette, Sun, TextQuote } from 'lucide-react'
import type { ReactNode } from 'react'
import { AppearanceControls } from '../components/AppearanceControls'
import { ReadingPreview } from '../components/ReadingPreview'
import { SyntaxThemeControls } from '../components/SyntaxThemeControls'
import { useAppearance } from '../lib/appearance'
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

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Apparence"
        description="Mémorisé sur cet appareil : régler ici ne change rien sur les autres."
      />

      <Card>
        <CardHeader
          title="Thème et couleurs"
          description="La teinte pilote les surfaces et l'accent."
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
                <span className="text-xs font-medium">{THEME_LABELS[option]}</span>
              </button>
            ))}
          </div>

          {/* Le thème contrasté est neutre par construction : teinte et intensité
              n'y produiraient rien, seule la luminosité a un effet. */}
          <AppearanceControls
            appearance={appearance}
            keys={theme === 'dark-contrast' ? ['lift'] : ['hue', 'tint', 'lift']}
          />
        </CardBody>
      </Card>

      {/* Carte à part, et pas un curseur de plus sous les couleurs : ces trois réglages
          ne touchent qu'au texte des messages, jamais à l'interface autour. */}
      <Card>
        <CardHeader
          title="Confort de lecture"
          description="S'applique au texte des messages, pas à l'interface."
          icon={<TextQuote size={16} />}
        />
        <CardBody className="flex flex-col gap-5">
          <AppearanceControls
            appearance={appearance}
            keys={['readingSize', 'readingLeading', 'readingSoftness']}
            swatches={false}
          />
          <ReadingPreview />
        </CardBody>
      </Card>

      {/* La palette de code ne touche à rien d'autre que le code, et la mélanger aux
          réglages de surfaces laisserait croire l'inverse. */}
      <Card>
        <CardHeader
          title="Coloration syntaxique"
          description="S'applique au code du fil, aux appels d'outils, aux diffs et à l'éditeur."
          icon={<Code size={16} />}
        />
        <CardBody>
          <SyntaxThemeControls />
        </CardBody>
      </Card>
    </div>
  )
}
