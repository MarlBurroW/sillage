import * as Dialog from '@radix-ui/react-dialog'
import { useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ArrowUpRight, Check, ChevronRight, Inbox, MessageCircleQuestion, X } from 'lucide-react'
import { NavLink, useMatch } from 'react-router-dom'
import type { ConversationDto, ConversationStatus, ProjectDto } from '@sillage/protocol'
import { liveBackground, liveSeq, liveSettledAt, liveStatus, subscribeStatus } from '../lib/conversation-status'
import { isUnread } from '../lib/reads'
import { useTranslate } from '../lib/i18n'
import { AgentIcon } from './AgentIcon'
import { ProjectAvatar } from './ProjectAvatar'
import { cx, IconButton } from './ui'

type ActivityEntry = {
  conversation: ConversationDto
  status: ConversationStatus
  running: boolean
  awaiting: boolean
  unread: boolean
  settledAt: number
}
type View = 'all' | 'awaiting' | 'unread'
const EMPTY: ConversationDto[] = []

export function SidebarActivity({ conversations = EMPTY, projects = [], onNavigate, children }: {
  conversations?: ConversationDto[]
  projects?: ProjectDto[]
  onNavigate: () => void
  children: ReactNode
}) {
  const t = useTranslate()
  const [collapsed, setCollapsed] = useState(false)
  const [expandedProject, setExpandedProject] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('all')
  const returnFocus = useRef<HTMLElement | null>(null)
  const openId = useMatch('/p/:projectId/c/:conversationId')?.params.conversationId
  // Un instantané primitif évite un rendu pour chaque jeton ou métrique reçue.
  const snapshot = () => JSON.stringify(conversations.map((entry) => ({
    status: liveStatus(entry.id) ?? entry.status,
    background: liveBackground(entry.id) > 0,
    unread: entry.id !== openId && isUnread(entry, liveSeq(entry.id)),
    settledAt: liveSettledAt(entry.id),
  })))
  const serialized = useSyncExternalStore(subscribeStatus, snapshot, snapshot)
  const entries = useMemo((): ActivityEntry[] => {
    const states = JSON.parse(serialized) as { status: ConversationStatus; background: boolean; unread: boolean; settledAt: number }[]
    return conversations.flatMap((conversation, index) => {
      const state = states[index]!
      const awaiting = state.status === 'awaiting_input'
      const running = !awaiting && (state.status === 'running' || state.background)
      // Une session archivée qui travaille encore compte bien dans le total global.
      if (conversation.archivedAt && !running && !awaiting) return []
      return [{ conversation, ...state, running, awaiting }]
    })
  }, [conversations, serialized])
  const running = entries.filter((entry) => entry.running)
  const awaiting = entries.filter((entry) => entry.awaiting)
  const unread = entries.filter((entry) => entry.unread)
  const recent = entries.filter((entry) => entry.settledAt > 0 && !entry.running && !entry.awaiting)
    .sort((a, b) => b.settledAt - a.settledAt).slice(0, 8)
  const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? t('shell.overview.unknown')
  const activeGroups = [...new Set([...awaiting, ...running].map((entry) => entry.conversation.projectId))]
    .map((id) => ({ id, entries: [...awaiting, ...running].filter((entry) => entry.conversation.projectId === id) }))
  const show = (next: View = 'all') => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setView(next)
    setOpen(true)
  }
  const navigate = () => { returnFocus.current = null; setOpen(false); onNavigate() }
  const grouped = (items: ActivityEntry[]) => [...new Set(items.map((entry) => entry.conversation.projectId))].map((id) => (
    <section key={id} className="mb-4">
      <h3 className="mb-1 flex items-center gap-2 px-2 text-xs font-semibold text-ink-soft">
        <ProjectAvatar project={projects.find((project) => project.id === id)} />
        <span className="truncate">{projectName(id)}</span>
        <span className="ml-auto tabular-nums text-ink-faint">{items.filter((entry) => entry.conversation.projectId === id).length}</span>
      </h3>
      <ul>{items.filter((entry) => entry.conversation.projectId === id).map((entry) => <ActivityRow key={entry.conversation.id} entry={entry} onNavigate={navigate} />)}</ul>
    </section>
  ))

  return (
    <>
      <div className="mb-2 flex shrink-0 flex-col border-b border-line pb-2" role="group" aria-label={t('shell.activity.label')}>
        <div className="flex items-center gap-1">
          <IconButton size="sm" label={t(collapsed ? 'shell.overview.expand' : 'shell.overview.collapse')} onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-controls="global-activity-projects">
            <ChevronRight size={13} className={cx('transition-transform', !collapsed && 'rotate-90')} />
          </IconButton>
          <button type="button" onClick={() => show()} aria-haspopup="dialog" className="flex min-h-11 md:min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md pr-2 text-xs hover:bg-surface-high">
            <span className="font-semibold text-ink-soft">{t('shell.overview.heading')}</span>
            <span className={cx('ml-auto flex items-center gap-1.5 rounded-full px-2 py-1 tabular-nums', running.length > 0 ? 'bg-accent-wash text-accent' : 'text-ink-faint')}>
              {running.length > 0 && <RunningDot />}{t('shell.overview.runningCount', { count: running.length })}
            </span>
            <ArrowUpRight size={12} className="shrink-0 text-ink-faint" />
          </button>
        </div>
        {awaiting.length > 0 && <button type="button" onClick={() => show('awaiting')} className="flex min-h-11 md:min-h-9 items-center gap-2 rounded-md px-2 text-xs text-caution hover:bg-surface-high">
          <MessageCircleQuestion size={14} />{t('shell.overview.awaitingCount', { count: awaiting.length })}<ChevronRight size={12} className="ml-auto" />
        </button>}
        {!collapsed && <div id="global-activity-projects" className="max-h-[25dvh] overflow-y-auto">
          {activeGroups.slice(0, 3).map((group) => {
            const countRunning = group.entries.filter((entry) => entry.running).length
            const countAwaiting = group.entries.length - countRunning
            const expanded = expandedProject === group.id
            return <div key={group.id}>
              <button type="button" aria-label={t('shell.overview.project', { name: projectName(group.id), running: countRunning, awaiting: countAwaiting })} aria-expanded={expanded} aria-controls={`activity-project-${group.id}`} onClick={() => setExpandedProject(expanded ? null : group.id)} className="flex min-h-11 md:min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-ink-soft hover:bg-surface-high">
                <ChevronRight size={11} className={cx('shrink-0 text-ink-faint transition-transform', expanded && 'rotate-90')} />
                <span className="min-w-0 flex-1 truncate">{projectName(group.id)}</span>
                {countAwaiting > 0 && <span className="flex items-center gap-1 tabular-nums text-caution"><MessageCircleQuestion size={12} />{countAwaiting}</span>}
                {countRunning > 0 && <span className="flex items-center gap-1.5 tabular-nums"><RunningDot />{countRunning}</span>}
              </button>
              {expanded && <div id={`activity-project-${group.id}`} className="ml-3 border-l border-line pl-1">
                <ul>{group.entries.slice(0, 3).map((entry) => <ActivityRow key={entry.conversation.id} entry={entry} onNavigate={onNavigate} compact />)}</ul>
                {group.entries.length > 3 && <button type="button" onClick={() => show()} className="min-h-11 md:min-h-9 px-2 text-left text-xs text-accent">{t('shell.overview.moreSessions', { count: group.entries.length })}</button>}
              </div>}
            </div>
          })}
          {activeGroups.length === 0 && <p className="px-2 py-2 text-xs text-ink-faint">{t('shell.overview.quiet')}</p>}
        </div>}
        <div className="flex items-center justify-between gap-1 px-1">
          <button type="button" onClick={() => show()} className="min-h-11 md:min-h-8 rounded px-1 text-left text-[0.6875rem] text-ink-faint hover:bg-surface-high hover:text-ink">
            {t(!collapsed && activeGroups.length > 3 ? (activeGroups.length === 4 ? 'shell.overview.moreProject' : 'shell.overview.moreProjects') : 'shell.overview.show', { count: activeGroups.length - 3 })}
          </button>
          <button type="button" onClick={() => show('unread')} aria-label={t('shell.overview.unreadCount', { count: unread.length })} className="flex min-h-11 md:min-h-8 items-center gap-1 rounded px-1 text-xs tabular-nums text-ink-faint hover:bg-surface-high hover:text-ink"><Inbox size={13} />{unread.length}</button>
        </div>
      </div>
      <div id="sidebar-activity-results" className="min-h-0 flex-1 overflow-y-auto pb-4">{children}</div>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content onCloseAutoFocus={(event) => {
            event.preventDefault()
            returnFocus.current?.focus()
          }} className="fixed top-[8dvh] left-1/2 z-50 flex max-h-[84dvh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-float">
            <div className="flex shrink-0 items-start justify-between gap-3 px-5 pt-4 pb-3">
              <div><Dialog.Title className="text-base font-semibold">{t('shell.overview.overview')}</Dialog.Title><Dialog.Description className="mt-1 text-xs text-ink-faint">{t('shell.overview.scope')}</Dialog.Description></div>
              <Dialog.Close asChild><IconButton label={t('common.close')}><X size={17} /></IconButton></Dialog.Close>
            </div>
            <div className="flex shrink-0 flex-wrap gap-1 border-b border-line px-4 pb-3" role="group" aria-label={t('shell.overview.overview')}>
              {(['all', 'awaiting', 'unread'] as const).map((item) => <button type="button" key={item} aria-pressed={view === item} onClick={() => setView(item)} className={cx('min-h-11 md:min-h-9 rounded-md px-3 text-xs', view === item ? 'bg-accent-wash font-medium text-accent' : 'text-ink-soft hover:bg-surface-high')}>
                {item === 'all' ? t('shell.overview.runningCount', { count: running.length }) : t(item === 'awaiting' ? 'shell.overview.awaitingCount' : 'shell.overview.unreadCount', { count: item === 'awaiting' ? awaiting.length : unread.length })}
              </button>)}
            </div>
            <div className="min-h-0 overflow-y-auto px-4 pt-4 pb-2">
              {view !== 'unread' && awaiting.length > 0 && <section aria-label={t('shell.activity.awaiting')}>
                <h2 className="mb-3 flex items-center gap-2 px-2 text-xs font-semibold text-caution"><MessageCircleQuestion size={14} />{t('shell.overview.awaitingCount', { count: awaiting.length })}</h2>
                {grouped(awaiting)}
              </section>}
              {view === 'all' && running.length > 0 && <section aria-label={t('shell.activity.running')}>
                <h2 className="mb-3 flex items-center gap-2 px-2 text-xs font-semibold text-accent"><RunningDot />{t('shell.overview.runningCount', { count: running.length })}</h2>
                {grouped(running)}
              </section>}
              {view === 'unread' && grouped(unread)}
              {(view === 'all' ? activeGroups.length === 0 : view === 'awaiting' ? awaiting.length === 0 : unread.length === 0) && <p role="status" className="px-2 py-8 text-center text-sm text-ink-faint">{t(view === 'all' ? 'shell.overview.quiet' : view === 'awaiting' ? 'shell.activity.empty.awaiting' : 'shell.activity.empty.unread')}</p>}
              {view === 'all' && recent.length > 0 && <section aria-label={t('shell.overview.recent')} className="border-t border-line pt-4">
                <h2 className="px-2 text-xs font-semibold text-ink-soft">{t('shell.overview.recent')}</h2>
                <p className="mb-3 px-2 pt-1 text-xs text-ink-faint">{t('shell.overview.recentHint')}</p>
                {grouped(recent)}
              </section>}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}

function RunningDot() {
  return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-accent motion-safe:animate-pulse" />
}

function ActivityRow({ entry, onNavigate, compact = false }: { entry: ActivityEntry; onNavigate: () => void; compact?: boolean }) {
  const t = useTranslate()
  const label = entry.awaiting ? t('shell.activity.awaiting')
    : entry.running ? t(entry.status === 'running' ? 'shell.activity.running' : 'shell.overview.background')
      : entry.status === 'error' ? t('shell.overview.error')
        : entry.status === 'interrupted' ? t('shell.overview.interrupted') : entry.settledAt ? t('shell.overview.done') : null
  return <li>
    <NavLink to={`/p/${entry.conversation.projectId}/c/${entry.conversation.id}`} onClick={onNavigate} className={({ isActive }) => cx('mb-1 flex items-start gap-2 rounded-md px-2 py-2 hover:bg-surface-high', isActive ? 'bg-accent-wash text-ink' : 'text-ink-soft')}>
      <span className="mt-0.5 shrink-0 text-ink-faint"><AgentIcon agent={entry.conversation.agent} size={14} /></span>
      <span className="min-w-0 flex-1"><span className={cx('block break-words', compact ? 'line-clamp-2 text-xs' : 'text-sm')}>{entry.conversation.title}</span>
        {label && <span className={cx('mt-1 flex items-center gap-1.5 text-[0.6875rem]', entry.awaiting || entry.status === 'error' ? 'text-caution' : 'text-ink-faint')}>
          {entry.awaiting ? <MessageCircleQuestion size={11} /> : entry.running ? <RunningDot /> : entry.settledAt && entry.status === 'idle' ? <Check size={11} /> : null}{label}
        </span>}
      </span>
    </NavLink>
  </li>
}
