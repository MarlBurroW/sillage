import {
  Bell,
  ChevronRight,
  Code,
  Contrast,
  Moon,
  Palette,
  ShieldCheck,
  Sun,
  UserRound,
  Users,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AccountForm } from '../components/AccountForm'
import { PushControls } from '../components/PushControls'
import { AppearanceControls } from '../components/AppearanceControls'
import { SyntaxThemeControls } from '../components/SyntaxThemeControls'
import { useAppearance } from '../lib/appearance'
import { THEMES, THEME_LABELS, useTheme, type Theme } from '../lib/theme'
import { useCurrentUser } from '../lib/session'
import { Badge, Card, CardBody, CardHeader, cx } from '../components/ui'

const THEME_ICONS: Record<Theme, ReactNode> = {
  light: <Sun size={15} />,
  dark: <Moon size={15} />,
  'dark-contrast': <Contrast size={15} />,
}

export function SettingsPage() {
  const { data: user } = useCurrentUser()
  const [theme, setTheme] = useTheme()
  const appearance = useAppearance()

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-4 md:p-8">
      <h1 className="text-lg font-semibold tracking-tight">Réglages</h1>

      <Card>
        <CardHeader
          title="Compte"
          icon={<UserRound size={16} />}
          actions={
            user?.isAdmin ? (
              <Badge tone="accent" icon={<ShieldCheck size={11} />}>
                Administrateur
              </Badge>
            ) : undefined
          }
        />
        <CardBody>
          {user ? (
            <AccountForm
              userId={user.id}
              username={user.username}
              displayName={user.displayName}
              isSelf
            />
          ) : null}
        </CardBody>
      </Card>

      {user?.isAdmin ? (
        <Link to="/settings/users" className="block">
          <Card className="transition-colors hover:border-line-strong">
            <CardBody className="flex items-center gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-wash text-accent">
                <Users size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[0.9375rem] font-semibold">Comptes</p>
                <p className="text-sm text-ink-faint">
                  Créer, promouvoir ou supprimer les comptes de l&apos;instance.
                </p>
              </div>
              <ChevronRight size={16} className="shrink-0 text-ink-faint" />
            </CardBody>
          </Card>
        </Link>
      ) : null}

      <Card>
        <CardHeader
          title="Notifications"
          description="Propre à cet appareil : activer ici ne change rien sur les autres."
          icon={<Bell size={16} />}
        />
        <CardBody>
          <PushControls />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Apparence"
          description="Mémorisé sur cet appareil. La teinte pilote les surfaces et l'accent."
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

      {/* Carte à part : la palette de code ne touche à rien d'autre que le code, et
          la mélanger aux réglages de surfaces laisserait croire l'inverse. */}
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

      {/* Sans repère de version, « je ne vois pas la correction » ne se tranche pas :
          rien à l'écran ne dit quelle version tourne réellement. */}
      <p className="px-1 text-[0.6875rem] text-ink-faint">
        Version installée du{' '}
        <time dateTime={__BUILD_TIME__}>
          {new Date(__BUILD_TIME__).toLocaleString('fr-FR')}
        </time>
      </p>
    </div>
  )
}
