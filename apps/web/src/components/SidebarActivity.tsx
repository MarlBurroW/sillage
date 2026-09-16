import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Inbox, LoaderCircle, MessageCircleQuestion, X } from 'lucide-react'
import { NavLink, useMatch } from 'react-router-dom'
import type { ConversationDto, ProjectDto } from '@sillage/protocol'
import { liveBackground, liveSeq, liveStatus, subscribeStatus } from '../lib/conversation-status'
import { isUnread } from '../lib/reads'
import { useTranslate } from '../lib/i18n'
import { AgentIcon } from './AgentIcon'
import { cx } from './ui'

const FILTERS = [
  { key: 'awaiting', label: 'shell.activity.awaiting', icon: MessageCircleQuestion },
  { key: 'running', label: 'shell.activity.running', icon: LoaderCircle },
  { key: 'unread', label: 'shell.activity.unread', icon: Inbox },
] as const
type Filter = typeof FILTERS[number]['key']
const EMPTY: ConversationDto[] = []

export function SidebarActivity({ conversations = EMPTY, projects = [], onNavigate, children }: {
  conversations?: ConversationDto[]
  projects?: ProjectDto[]
  onNavigate: () => void
  children: ReactNode
}) {
  const t = useTranslate()
  const [filter, setFilter] = useState<Filter | null>(null)
  const openId = useMatch('/p/:projectId/c/:conversationId')?.params.conversationId
  // Seule l'appartenance aux listes déclenche un rendu, pas chaque jeton reçu.
  // L'instantané primitif reste stable même si les métriques continuent à changer.
  const snapshot = () => {
    const lists: Record<Filter, string[]> = { awaiting: [], running: [], unread: [] }
    for (const entry of conversations) {
      if (entry.archivedAt) continue
      const status = liveStatus(entry.id) ?? entry.status
      if (status === 'awaiting_input') lists.awaiting.push(entry.id)
      if (status === 'running' || (status !== 'awaiting_input' && liveBackground(entry.id) > 0)) lists.running.push(entry.id)
      if (entry.id !== openId && isUnread(entry, liveSeq(entry.id))) lists.unread.push(entry.id)
    }
    return JSON.stringify(lists)
  }
  const serialized = useSyncExternalStore(subscribeStatus, snapshot, snapshot)
  const lists = useMemo(() => JSON.parse(serialized) as Record<Filter, string[]>, [serialized])
  const selected = filter ? new Set(lists[filter]) : null
  const matches = selected ? conversations.filter((entry) => selected.has(entry.id))
    .sort((a, b) => b.updatedAt - a.updatedAt) : []

  return (
    <>
      <div className="mb-3 border-b border-line pb-2" role="group" aria-label={t('shell.activity.label')}>
        {FILTERS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            aria-controls="sidebar-activity-results"
            onClick={() => setFilter(filter === key ? null : key)}
            className={cx(
              'flex min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-sm md:min-h-9 pointer-coarse:min-h-11',
              filter === key ? 'bg-accent-wash font-medium text-ink' : 'text-ink-soft hover:bg-surface-high',
            )}
          >
            <Icon size={15} className={cx('shrink-0', key === 'awaiting' && lists[key].length > 0 && 'text-caution')} />
            <span className="flex-1 text-left">{t(label)}</span>
            <span className="text-xs tabular-nums text-ink-faint">{lists[key].length}</span>
          </button>
        ))}
      </div>
      <div id="sidebar-activity-results">
        {filter ? (
          <>
            <button type="button" onClick={() => setFilter(null)} className="mb-2 flex min-h-11 items-center gap-2 px-2.5 text-xs text-ink-soft hover:text-ink md:min-h-9">
              <X size={13} />{t('shell.activity.clear')}
            </button>
            {matches.length === 0 ? <p className="px-2.5 py-4 text-sm text-ink-faint" role="status">{t(`shell.activity.empty.${filter}`)}</p> : (
              <ul className="flex flex-col gap-1">
                {matches.map((conversation) => (
                  <li key={conversation.id}>
                    <NavLink
                      to={`/p/${conversation.projectId}/c/${conversation.id}`}
                      onClick={onNavigate}
                      className={({ isActive }) => cx('flex items-start gap-2 rounded-md px-2.5 py-2.5', isActive ? 'bg-accent-wash text-ink' : 'text-ink-soft hover:bg-surface-high')}
                    >
                      <span className="mt-0.5 shrink-0 text-ink-faint"><AgentIcon agent={conversation.agent} size={14} /></span>
                      <span className="min-w-0">
                        <span className="line-clamp-2 break-words text-[0.8125rem] font-medium">{conversation.title}</span>
                        <span className="mt-1 block truncate text-xs text-ink-faint">{projects.find((project) => project.id === conversation.projectId)?.name}</span>
                      </span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : children}
      </div>
    </>
  )
}
