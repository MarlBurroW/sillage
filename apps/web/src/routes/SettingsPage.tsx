import {
  Archive,
  Rss,
  Bell,
  BookOpen,
  ChevronRight,
  Search,
  X,
  FileText,
  Cpu,
  Info,
  GitBranch,
  Globe,
  Shield,
  Bot,
  KeyRound,
  Mic,
  Palette,
  Plug,
  SlidersHorizontal,
  Terminal,
  UserRound,
  Users,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom'
import { locale, useTranslate, type MessageKey } from '../lib/i18n'
import { foldForMatch, type InstanceCapabilities } from '@sillage/protocol'
import { useInstance } from '../lib/instance'
import { useCurrentUser } from '../lib/session'
import { useCliUpdateNotice } from '../lib/agents'
import { useVersionInfo } from '../lib/system'
import { UpdateDot } from '../components/UpdateDot'
import { AgentIcon } from '../components/AgentIcon'
import { useMediaQuery } from '../lib/viewport'
import { Field, IconButton, cx } from '../components/ui'

/**
 * Settings grouped by category.
 *
 * A single page stacked unrelated cards, lengthening with each setting. Categories are routes:
 * shareable, bookmarkable, and navigable with the phone back button.
 *
 * Two layouts share one route tree. On large screens the list occupies a left column beside the
 * section. On touch screens the list is the page: `/settings` shows it alone; opening a
 * category replaces it with a back link. This familiar list-detail pattern avoids squeezing a
 * navigation column into insufficient width.
 *
 * Groups are headings, not disclosure buttons: the list is short enough to scroll, and folding
 * hid where a category lived behind a click, which is what the user came to find out.
 */
interface Section {
  to: string
  group: 'personal' | 'agents' | 'workspace' | 'administration' | 'about'
  labelKey: MessageKey
  descriptionKey: MessageKey
  icon: ReactNode
  adminOnly?: boolean
  /** Instance capability required for this category to make sense. */
  requires?: keyof InstanceCapabilities
}

/**
 * Categories visible to this user on this instance. Shared with search, which must not suggest
 * categories hidden by the page.
 */
export function visibleSections(isAdmin: boolean, capabilities: InstanceCapabilities | undefined): Section[] {
  return SECTIONS.filter(
    (section) =>
      (!section.adminOnly || isAdmin) && (!section.requires || (capabilities?.[section.requires] ?? true)),
  )
}

/** Read through `visibleSections`, which enforces permissions and capabilities. */
const SECTIONS: Section[] = [
  {
    to: 'veille',
    group: 'personal',
    labelKey: 'news.title',
    descriptionKey: 'news.description',
    icon: <Rss size={16} />,
  },
  {
    to: 'compte',
    group: 'personal',
    labelKey: 'settings.section.account',
    descriptionKey: 'settings.section.account.description',
    icon: <UserRound size={16} />,
    requires: 'passwordAuth',
  },
  {
    to: 'apparence',
    group: 'personal',
    labelKey: 'settings.section.appearance',
    descriptionKey: 'settings.section.appearance.description',
    icon: <Palette size={16} />,
  },
  {
    to: 'notifications',
    group: 'personal',
    labelKey: 'settings.section.notifications',
    descriptionKey: 'settings.section.notifications.description',
    icon: <Bell size={16} />,
    requires: 'webPush',
  },
  {
    to: 'cli',
    group: 'agents',
    labelKey: 'settings.section.cli',
    descriptionKey: 'settings.section.cli.description',
    icon: <SlidersHorizontal size={16} />,
  },
  {
    to: 'cli-versions', group: 'agents', labelKey: 'cliUpdates.title',
    descriptionKey: 'cliUpdates.navDescription', icon: <Terminal size={16} />,
  },
  {
    to: 'mcp',
    group: 'workspace',
    labelKey: 'settings.section.mcp',
    descriptionKey: 'settings.section.mcp.description',
    icon: <Plug size={16} />,
  },
  {
    to: 'consignes',
    group: 'workspace',
    labelKey: 'settings.section.instructions',
    descriptionKey: 'settings.section.instructions.description',
    icon: <FileText size={16} />,
  },
  {
    to: 'skills',
    group: 'workspace',
    labelKey: 'settings.section.skills',
    descriptionKey: 'settings.section.skills.description',
    icon: <BookOpen size={16} />,
  },
  {
    to: 'api',
    group: 'workspace',
    labelKey: 'settings.section.api',
    descriptionKey: 'settings.section.api.description',
    icon: <Terminal size={16} />,
  },
  {
    to: 'git',
    group: 'workspace',
    labelKey: 'settings.section.git',
    descriptionKey: 'settings.section.git.description',
    icon: <GitBranch size={16} />,
  },
  {
    to: 'comptes-claude',
    group: 'agents',
    labelKey: 'settings.section.claudeAccounts',
    descriptionKey: 'settings.section.claudeAccounts.description',
    icon: <AgentIcon agent="claude" size={16} />,
  },
  {
    to: 'comptes-codex',
    group: 'agents',
    labelKey: 'settings.section.codexAccounts',
    descriptionKey: 'settings.section.codexAccounts.description',
    icon: <AgentIcon agent="codex" size={16} />,
  },
  {
    to: 'comptes-grok',
    group: 'agents',
    labelKey: 'settings.section.grokAccounts',
    descriptionKey: 'settings.section.grokAccounts.description',
    icon: <AgentIcon agent="grok" size={16} />,
  },
  {
    to: 'comptes-antigravity',
    group: 'agents',
    labelKey: 'settings.section.antigravityAccounts',
    descriptionKey: 'settings.section.antigravityAccounts.description',
    icon: <AgentIcon agent="antigravity" size={16} />,
  },
  {
    to: 'secrets',
    group: 'administration',
    labelKey: 'settings.section.secrets',
    descriptionKey: 'settings.section.secrets.description',
    icon: <KeyRound size={16} />,
    adminOnly: true,
  },
  {
    to: 'dictee',
    group: 'administration',
    labelKey: 'settings.section.stt',
    descriptionKey: 'settings.section.stt.description',
    icon: <Mic size={16} />,
    adminOnly: true,
  },
  {
    to: 'archivage',
    group: 'administration',
    labelKey: 'settings.section.archiving',
    descriptionKey: 'settings.section.archiving.description',
    icon: <Archive size={16} />,
    adminOnly: true,
  },
  {
    to: 'sessions',
    group: 'administration',
    labelKey: 'settings.section.sessions',
    descriptionKey: 'settings.section.sessions.description',
    icon: <Cpu size={16} />,
    adminOnly: true,
  },
  {
    to: 'comptes',
    group: 'administration',
    labelKey: 'settings.section.accounts',
    descriptionKey: 'settings.section.accounts.description',
    icon: <Users size={16} />,
    adminOnly: true,
    requires: 'passwordAuth',
  },
  {
    to: 'a-propos',
    group: 'about',
    labelKey: 'settings.section.about',
    descriptionKey: 'settings.section.about.description',
    icon: <Info size={16} />,
  },
]

const GROUPS = ['personal', 'agents', 'workspace', 'administration', 'about'] as const
const GROUP_ICONS: Record<Section['group'], ReactNode> = {
  personal: <UserRound size={13} />,
  agents: <Bot size={13} />,
  workspace: <Globe size={13} />,
  administration: <Shield size={13} />,
  about: null,
}

export function SettingsLayout() {
  const t = useTranslate()
  const { data: user } = useCurrentUser()
  const { data: versionInfo } = useVersionInfo()
  const cliUpdateNotice = useCliUpdateNotice()
  const { pathname } = useLocation()
  const { data: instance } = useInstance()
  const sections = visibleSections(Boolean(user?.isAdmin), instance?.capabilities)
  const [query, setQuery] = useState('')
  const terms = foldForMatch(query).trim().split(/\s+/).filter(Boolean)
  const filtered = sections.filter((entry) => {
    const text = foldForMatch(`${t(entry.labelKey)} ${t(entry.descriptionKey)} ${entry.group === 'about' ? '' : t(`settings.group.${entry.group}`)}`)
    return terms.every((term) => text.includes(term))
  })
  const onIndex = pathname === '/settings' || pathname === '/settings/'
  // Keep list/detail until the app sidebar leaves enough room for a second navigation column.
  // Must match Tailwind `lg:`, which controls both layouts.
  const wide = useMediaQuery('(min-width: 64rem)')

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-6 p-4 lg:flex-row lg:gap-8 lg:p-8">
      {/*
       * Scroll the menu independently so short pages stay short and long pages retain navigation.
       * On phones, show either the menu or its detail, as both cannot fit side by side.
       */}
      <nav aria-label={t('settings.title')} className={cx('flex min-h-0 flex-1 flex-col lg:w-56 lg:flex-none', !onIndex && 'hidden lg:flex')}>
        <h1 className="mb-3 px-1 text-lg font-semibold tracking-tight">{t('settings.title')}</h1>
        <div className="mb-3 flex shrink-0 items-end gap-1">
          <div className="min-w-0 flex-1">
            <Field type="search" label={t('settings.search')} icon={<Search size={14} />} value={query}
              onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setQuery('') }} />
          </div>
          {query ? <IconButton label={t('settings.search.clear')} onClick={() => setQuery('')}><X size={15} /></IconButton> : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-settings-list>
        {filtered.length === 0 ? <p role="status" className="px-2 py-3 text-sm text-ink-faint">{t('settings.search.empty')}</p> : null}
        {GROUPS.map((group) => {
          const entries = filtered.filter((section) => section.group === group)
          if (entries.length === 0) return null
          return (
            <div key={group} className="mb-5">
              {group !== 'about' ? (
                <h2 id={`settings-group-${group}`}
                  className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-ink-soft">
                  {GROUP_ICONS[group]}
                  <span>{t(`settings.group.${group}`)}</span>
                </h2>
              ) : null}
              {/* Entries sit one icon width under their heading: the indent is what reads as hierarchy. */}
              <ul aria-labelledby={group !== 'about' ? `settings-group-${group}` : undefined}
                className={cx('flex flex-col gap-0.5', group !== 'about' && 'pl-5')}>
                {entries.map((section) => (
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
                      <span aria-hidden className="relative shrink-0 text-ink-faint">
                        {section.icon}
                        {(section.to === 'a-propos' && versionInfo?.updateAvailable) || (section.to === 'cli-versions' && cliUpdateNotice) ? <UpdateDot /> : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{t(section.labelKey)}</span>
                        {/*
                         * Descriptions help only on touch screens, where the list fills the
                         * page and nothing else explains category contents.
                         */}
                        <span className="block text-xs text-ink-faint lg:hidden">
                          {t(section.descriptionKey)}
                        </span>
                      </span>
                      <ChevronRight size={14} className="shrink-0 text-ink-faint lg:hidden" />
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}

        {/*
         * Without a version indicator, “I cannot see the fix” is impossible to resolve: nothing
         * shows the actual running version.
         */}
        <p className="mt-4 px-2.5 text-[0.6875rem] text-ink-faint">
          {t('settings.buildInfo', { version: __APP_VERSION__ })}{' '}
          <time dateTime={__BUILD_TIME__}>{new Date(__BUILD_TIME__).toLocaleString(locale())}</time>
        </p>
        </div>
      </nav>

      <div key={pathname} className={cx(
        'min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain',
        onIndex && 'hidden lg:block',
      )}>
        {/*
         * On large screens, `/settings` without a section would show an empty column: select
         * the first. Redirect based on actual width, not CSS `hidden`: hidden elements stay
         * mounted and would redirect the phone list too.
         */}
        {onIndex ? wide ? <Navigate to={sections[0]?.to ?? 'a-propos'} replace /> : null : <Outlet />}
      </div>
    </div>
  )
}

/** Back to the list on touch layouts only; elsewhere the column is already visible. */
export function SectionHeader({
  title,
  description,
  badge,
}: {
  title: string
  description?: string
  /** Beside the title: status applies to the whole section, not a card. */
  badge?: ReactNode
}) {
  const t = useTranslate()
  return (
    <header className="mb-4 flex flex-col gap-1">
      <NavLink
        to="/settings"
        className="flex items-center gap-1 text-sm text-ink-faint hover:text-ink lg:hidden"
      >
        <ChevronRight size={14} className="rotate-180" />
        {t('settings.title')}
      </NavLink>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {badge}
      </div>
      {description ? <p className="text-sm text-ink-faint">{description}</p> : null}
    </header>
  )
}

/**
 * Settings-list header: title, entry count and add action.
 *
 * List before form: users open registries to inspect contents more often than to add entries. A
 * permanently expanded top form pushed what they came to see below the fold.
 */
export function ListHeading({
  title,
  count,
  action,
}: {
  title: string
  count?: number
  action?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-soft">
        {title}
        {count ? (
          <span className="rounded-full bg-surface-high px-1.5 text-xs font-medium text-ink-faint tabular-nums">
            {count}
          </span>
        ) : null}
      </h2>
      {action}
    </div>
  )
}
