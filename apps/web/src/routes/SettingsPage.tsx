import {
  Archive,
  Bell,
  ChevronRight,
  FolderOpen,
  Info,
  KeyRound,
  Palette,
  Plug,
  Terminal,
  UserRound,
  Users,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom'
import { locale, useTranslate, type MessageKey } from '../lib/i18n'
import { useCurrentUser } from '../lib/session'
import { useVersionInfo } from '../lib/system'
import { useMediaQuery } from '../lib/viewport'
import { cx } from '../components/ui'

/**
 * Réglages, rangés par catégorie.
 *
 * Une page unique empilait des cartes sans rapport les unes sous les autres, et chaque
 * réglage ajouté allongeait le défilement. Les catégories sont des routes : elles se
 * partagent, se mettent en favori, et le bouton retour du téléphone les traverse.
 *
 * Deux dispositions pour un seul arbre de routes. Sur grand écran, la liste est une
 * colonne posée à gauche et la section vit à côté. Au doigt, la liste est la page :
 * `/settings` la montre seule, et ouvrir une catégorie la remplace, avec un retour vers
 * la liste. C'est le motif liste-détail habituel, et il évite d'entasser une colonne de
 * navigation dans une largeur qui n'en a pas.
 */
interface Section {
  to: string
  labelKey: MessageKey
  descriptionKey: MessageKey
  icon: ReactNode
  adminOnly?: boolean
}

const SECTIONS: Section[] = [
  {
    to: 'compte',
    labelKey: 'settings.section.account',
    descriptionKey: 'settings.section.account.description',
    icon: <UserRound size={16} />,
  },
  {
    to: 'apparence',
    labelKey: 'settings.section.appearance',
    descriptionKey: 'settings.section.appearance.description',
    icon: <Palette size={16} />,
  },
  {
    to: 'notifications',
    labelKey: 'settings.section.notifications',
    descriptionKey: 'settings.section.notifications.description',
    icon: <Bell size={16} />,
  },
  {
    to: 'projets',
    labelKey: 'settings.section.projects',
    descriptionKey: 'settings.section.projects.description',
    icon: <FolderOpen size={16} />,
  },
  {
    to: 'mcp',
    labelKey: 'settings.section.mcp',
    descriptionKey: 'settings.section.mcp.description',
    icon: <Plug size={16} />,
  },
  {
    to: 'api',
    labelKey: 'settings.section.api',
    descriptionKey: 'settings.section.api.description',
    icon: <Terminal size={16} />,
  },
  {
    to: 'secrets',
    labelKey: 'settings.section.secrets',
    descriptionKey: 'settings.section.secrets.description',
    icon: <KeyRound size={16} />,
    adminOnly: true,
  },
  {
    to: 'archivage',
    labelKey: 'settings.section.archiving',
    descriptionKey: 'settings.section.archiving.description',
    icon: <Archive size={16} />,
    adminOnly: true,
  },
  {
    to: 'comptes',
    labelKey: 'settings.section.accounts',
    descriptionKey: 'settings.section.accounts.description',
    icon: <Users size={16} />,
    adminOnly: true,
  },
  {
    to: 'a-propos',
    labelKey: 'settings.section.about',
    descriptionKey: 'settings.section.about.description',
    icon: <Info size={16} />,
  },
]

export function SettingsLayout() {
  const t = useTranslate()
  const { data: user } = useCurrentUser()
  const { data: versionInfo } = useVersionInfo()
  const { pathname } = useLocation()
  const sections = SECTIONS.filter((section) => !section.adminOnly || user?.isAdmin)
  const onIndex = pathname === '/settings' || pathname === '/settings/'
  // Doit rester aligné sur `md:` de Tailwind, qui commande les deux dispositions.
  const wide = useMediaQuery('(min-width: 48rem)')

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 md:flex-row md:gap-8 md:p-8">
      {/* La liste disparaît au doigt dès qu'une section est ouverte : les deux
          ensemble ne tiennent pas dans la largeur d'un téléphone. */}
      <nav className={cx('shrink-0 md:w-56', !onIndex && 'hidden md:block')}>
        <h1 className="mb-3 px-1 text-lg font-semibold tracking-tight">{t('settings.title')}</h1>
        <ul className="flex flex-col gap-1">
          {sections.map((section) => (
            <li key={section.to}>
              <NavLink
                to={section.to}
                className={({ isActive }) =>
                  cx(
                    'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
                    isActive
                      ? 'bg-accent-wash font-medium text-ink'
                      : 'text-ink-soft hover:bg-surface-high hover:text-ink',
                  )
                }
              >
                <span className="relative shrink-0 text-ink-faint">
                  {section.icon}
                  {/* Une pastille, pas un toast : la mise à jour attend sans presser. */}
                  {section.to === 'a-propos' && versionInfo?.updateAvailable ? (
                    <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accent" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{t(section.labelKey)}</span>
                  {/* La description n'aide qu'au doigt, où la liste est la page entière
                      et où rien d'autre ne dit ce qu'une catégorie contient. */}
                  <span className="block truncate text-xs text-ink-faint md:hidden">
                    {t(section.descriptionKey)}
                  </span>
                </span>
                <ChevronRight size={14} className="shrink-0 text-ink-faint md:hidden" />
              </NavLink>
            </li>
          ))}
        </ul>

        {/* Sans repère de version, « je ne vois pas la correction » ne se tranche pas :
            rien à l'écran ne dit quelle version tourne réellement. */}
        <p className="mt-4 px-2.5 text-[0.6875rem] text-ink-faint">
          {t('settings.buildInfo', { version: __APP_VERSION__ })}{' '}
          <time dateTime={__BUILD_TIME__}>{new Date(__BUILD_TIME__).toLocaleString(locale())}</time>
        </p>
      </nav>

      <div className={cx('min-w-0 flex-1', onIndex && 'hidden md:block')}>
        {/* Sur grand écran, arriver sur `/settings` sans section afficherait une colonne
            vide : la première prend la main. La redirection est conditionnée à la
            largeur réelle et non à une classe `hidden` : un élément caché en CSS reste
            monté, et la liste du téléphone se serait redirigée toute seule. */}
        {onIndex ? wide ? <Navigate to="compte" replace /> : null : <Outlet />}
      </div>
    </div>
  )
}

/** Retour vers la liste, au doigt seulement : ailleurs la colonne est déjà visible. */
export function SectionHeader({ title, description }: { title: string; description?: string }) {
  const t = useTranslate()
  return (
    <header className="mb-4 flex flex-col gap-1">
      <NavLink
        to="/settings"
        className="flex items-center gap-1 text-sm text-ink-faint hover:text-ink md:hidden"
      >
        <ChevronRight size={14} className="rotate-180" />
        {t('settings.title')}
      </NavLink>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {description ? <p className="text-sm text-ink-faint">{description}</p> : null}
    </header>
  )
}
