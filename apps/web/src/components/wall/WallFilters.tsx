import { clearQueryKey, parseSessionQuery, queryValues, SESSION_STATES, toggleQueryValue, type ProjectDto, type SessionQueryKey } from '@sillage/protocol'
import { ArrowDownUp, Bot, ChevronDown, CircleAlert, Clock, Folder, GitBranch, Hash, Inbox, Play, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslate } from '../../lib/i18n'
import { AgentIcon } from '../AgentIcon'
import { cx, Menu, MenuCheckboxItem, MenuItem, MenuLabel, MenuSeparator } from '../ui'
import { MenuHint } from '../ui/Menu'
import { WorktreeStateIcon } from '../WorktreeTag'
import { KEY_HELP, keyValues } from './query-vocabulary'

/** Running and attention share one token (“either”); unread keeps its own (“and”). */
const TOGGLES: { value: string; group: readonly string[]; icon: ReactNode; label: 'wall.filter.running' | 'wall.filter.attention' | 'wall.filter.unread' }[] = [
  { value: 'running', group: SESSION_STATES, icon: <Play size={13} />, label: 'wall.filter.running' },
  { value: 'attention', group: SESSION_STATES, icon: <CircleAlert size={13} />, label: 'wall.filter.attention' },
  { value: 'unread', group: ['unread'], icon: <Inbox size={13} />, label: 'wall.filter.unread' },
]

const MENUS: { key: SessionQueryKey; icon: ReactNode; label: 'wall.filter.project' | 'wall.filter.cli' | 'wall.filter.worktree' | 'wall.filter.active' | 'wall.filter.limit' | 'wall.filter.sort' }[] = [
  { key: 'project', icon: <Folder size={13} />, label: 'wall.filter.project' },
  { key: 'cli', icon: <Bot size={13} />, label: 'wall.filter.cli' },
  { key: 'worktree', icon: <GitBranch size={13} />, label: 'wall.filter.worktree' },
  { key: 'active', icon: <Clock size={13} />, label: 'wall.filter.active' },
  { key: 'limit', icon: <Hash size={13} />, label: 'wall.filter.limit' },
  { key: 'sort', icon: <ArrowDownUp size={13} />, label: 'wall.filter.sort' },
]
const MULTI = new Set<SessionQueryKey>(['project', 'cli', 'worktree'])
/** Menus hide values that make no sense as a button; typing still accepts them. */
const MENU_VALUES: Partial<Record<SessionQueryKey, string[]>> = { worktree: ['dirty', 'unmerged', 'leftovers', 'merged', 'missing'] }

/**
 * Buttons that write into the query. They hold no state: a button looks selected whenever its
 * token is in the text, typed by hand or not, and each menu shows the token it writes.
 */
export function WallFilters({ query, onChange, projects }: { query: string; onChange: (query: string) => void; projects: readonly ProjectDto[] }) {
  const t = useTranslate()
  return (
    <div className="wall-filters" role="toolbar" aria-label={t('wall.filter.label')}>
      {TOGGLES.map((toggle) => {
        const on = queryValues(query, 'is', toggle.group).includes(toggle.value)
        return (
          <button key={toggle.value} type="button" className="wall-chip" aria-pressed={on}
            onClick={() => onChange(toggleQueryValue(query, 'is', toggle.value, toggle.group))}>
            {toggle.icon}{t(toggle.label)}
          </button>
        )
      })}
      <span className="wall-filters-separator" aria-hidden />
      {MENUS.map((menu) => {
        const options = keyValues(menu.key, projects, t).filter((option) => !MENU_VALUES[menu.key] || MENU_VALUES[menu.key]!.includes(option.value))
        const selected = queryValues(query, menu.key)
        const labels = selected.map((value) => options.find((option) => option.value === value)?.label ?? value)
        const written = parseSessionQuery(query).find((token) => token.key === menu.key && !token.negated)?.raw
        return (
          <Menu key={menu.key} align="start" trigger={
            <button type="button" className="wall-chip" aria-pressed={selected.length > 0} aria-haspopup="menu">
              {menu.icon}{t(menu.label)}
              {labels.length ? <span className="wall-chip-value">{labels.length > 2 ? `${labels[0]} +${labels.length - 1}` : labels.join(', ')}</span> : null}
              <ChevronDown size={12} className="text-ink-faint" />
            </button>
          }>
            <MenuLabel>{t(KEY_HELP[menu.key])}{MULTI.has(menu.key) ? ` · ${t('wall.filter.several')}` : ''}</MenuLabel>
            {options.length === 0 ? <MenuHint>{t('wall.filter.noProjects')}</MenuHint> : null}
            {options.map((option) => (
              <MenuCheckboxItem key={option.value} checked={selected.includes(option.value)}
                onCheckedChange={() => onChange(toggleQueryValue(query, menu.key, option.value))}>
                <span className={cx('flex min-w-0 items-center gap-2')}>
                  {menu.key === 'cli' ? <AgentIcon agent={option.value as Parameters<typeof AgentIcon>[0]['agent']} size={14} /> : null}
                  {menu.key === 'worktree' ? <WorktreeStateIcon state={option.value as Parameters<typeof WorktreeStateIcon>[0]['state']} /> : null}
                  <span className="truncate">{option.label}</span>
                </span>
              </MenuCheckboxItem>
            ))}
            {selected.length ? <>
              <MenuSeparator />
              <MenuItem icon={<X size={14} />} onSelect={() => onChange(clearQueryKey(query, menu.key))}>{t('wall.filter.clear')}</MenuItem>
            </> : null}
            <MenuHint>{t('wall.filter.writes')} <code className="font-mono text-ink-soft">{written ?? `${menu.key}:…`}</code></MenuHint>
          </Menu>
        )
      })}
    </div>
  )
}
