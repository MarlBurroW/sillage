import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { ConversationDto, ProjectDto, ScheduledTaskDto } from '@sillage/protocol'
import { Archive, CalendarClock, ChevronRight, FolderGit2, MoreHorizontal, Pin, PinOff, Plus, RefreshCw, Search, SlidersHorizontal, SquareKanban, SquareTerminal, Users, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useReorderConversations } from '../../lib/conversations'
import { useRefreshLists } from '../../lib/conversation-status'
import { useTranslate } from '../../lib/i18n'
import { useTogglePin, useUpdateProject } from '../../lib/projects'
import { useWorktreeStatuses, worktreeCounts } from '../../lib/worktrees'
import { ProjectAvatar } from '../ProjectAvatar'
import { Tooltip } from '../ui/Tooltip'
import { IconButton, Menu, MenuItem, MenuSeparator, cx } from '../ui'
import { ColumnHead, ColumnHeading, useNavChrome } from './chrome'
import { ProjectMenuItems } from './ProjectMenuItems'
import { SessionRow, type FavoriteMutation } from './SessionRow'
import { RenameInput, swallowNextClick, useDragSensors } from './shared'

/**
 * A project's column: its views, then its sessions over all the height left. Nothing global sits
 * above them any more, so the list needs no "show more" step.
 */
export function ProjectColumn({ project, conversations, schedules, toggleFavorite }: {
  project: ProjectDto
  /** Active and archived together: the column separates them itself. */
  conversations: ConversationDto[]
  schedules: ScheduledTaskDto[]
  toggleFavorite: FavoriteMutation
}) {
  const t = useTranslate()
  const navigate = useNavigate()
  const { onNavigate } = useNavChrome()
  const updateProject = useUpdateProject()
  const togglePin = useTogglePin()
  const reorder = useReorderConversations(project.id)
  const { refreshing, refresh } = useRefreshLists()
  // Scheduled runs live beneath their task on the scheduling page, not among followed sessions.
  const active = useMemo(() => conversations.filter((entry) => !entry.archivedAt && !entry.scheduleId), [conversations])
  const archived = useMemo(() => conversations.filter((entry) => entry.archivedAt && !entry.scheduleId), [conversations])
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState(false)
  const filterInput = useRef<HTMLInputElement>(null)
  const { data: treeStatus } = useWorktreeStatuses(project.id)
  const query = filter.trim().toLocaleLowerCase()
  const matching = active.filter((entry) => !query || entry.title.toLocaleLowerCase().includes(query)
    || treeStatus?.worktrees.some((tree) => tree.conversations.some((link) => link.id === entry.id) && `${tree.name} ${tree.branch ?? ''}`.toLocaleLowerCase().includes(query)))
  const sensors = useDragSensors()

  const onDragEnd = (event: DragEndEvent) => {
    // Dragging ends with mouseup on the link, causing a click: suppress it or reordering opens the conversation.
    swallowNextClick()
    const { active: dragged, over } = event
    if (!over || dragged.id === over.id) return
    const ids = active.map((entry) => entry.id)
    const from = ids.indexOf(String(dragged.id))
    const to = ids.indexOf(String(over.id))
    if (from === -1 || to === -1) return
    reorder.mutate(arrayMove(ids, from, to))
  }

  const go = (path: string) => { navigate(path); onNavigate() }
  const link = ({ isActive }: { isActive: boolean }) => cx('sidebar-project-link', isActive && 'sidebar-current')

  return (
    <>
      <ColumnHead
        lead={<ProjectAvatar project={project} className="size-5" />}
        title={editing ? (
          <RenameInput value={project.name} onCancel={() => setEditing(false)} onCommit={(draft) => {
            setEditing(false)
            const name = draft.trim()
            if (name && name !== project.name) updateProject.mutate({ id: project.id, name })
          }} className="h-8 w-full rounded border border-accent bg-sunken px-2 text-sm font-normal outline-none" />
        ) : (
          // Double-click renames, as in file explorers.
          <span className="flex min-w-0 items-center gap-2" title={project.name} onDoubleClick={() => { if (project.isOwner) setEditing(true) }}>
            <span className="truncate">{project.name}</span>
            {/* A project shell is running: reminder for development servers left behind closed sessions. */}
            {project.activeTerminals > 0 ? <SquareTerminal size={12} className="shrink-0 text-positive" aria-label={t('shell.project.terminals')} /> : null}
            {/* Mark only shared projects: private is normal and a lock on every project adds no information. */}
            {project.visibility === 'shared' ? <Users size={12} className="shrink-0 text-ink-faint" aria-label={t('shell.project.shared')} /> : null}
          </span>
        )}
        actions={<Menu trigger={<IconButton label={t('shell.project.actions', { name: project.name })} size="sm"><MoreHorizontal size={16} /></IconButton>}>
          {project.isOwner ? <ProjectMenuItems variant="dropdown" project={project} onRename={() => setEditing(true)} onNavigate={onNavigate} />
            : <MenuItem icon={<SlidersHorizontal size={14} />} onSelect={() => go(`/p/${project.id}`)}>{t('shell.project.settings')}</MenuItem>}
          <MenuSeparator />
          <MenuItem icon={project.pinned ? <PinOff size={14} /> : <Pin size={14} />} onSelect={() => togglePin.mutate({ id: project.id, pinned: !project.pinned })}>{t(project.pinned ? 'shell.rail.unpin' : 'shell.rail.pin')}</MenuItem>
          <MenuItem icon={<RefreshCw size={14} />} disabled={refreshing} onSelect={refresh}>{t('shell.refresh')}</MenuItem>
        </Menu>}
      />
      <ul className="sidebar-project-links">
        <li><NavLink to={`/p/${project.id}/board`} onClick={onNavigate} className={link}><SquareKanban size={14} /><span className="flex-1">{t('shell.project.board')}</span><BoardCounts counts={project.cardCounts} /></NavLink></li>
        <WorktreesLine projectId={project.id} />
        <li><NavLink to={`/p/${project.id}/schedules`} onClick={onNavigate} className={link}><CalendarClock size={14} /><span className="flex-1">{t('schedule.sidebar.heading')}</span><span className="text-[0.625rem] text-ink-faint">{schedules.length}</span></NavLink></li>
      </ul>
      <ColumnHeading label={t('shell.project.sessions')} count={active.length}>
        <IconButton label={t('shell.sessions.filter')} size="sm" aria-expanded={filterOpen} onClick={() => { setFilterOpen((value) => !value); setFilter(''); if (!filterOpen) requestAnimationFrame(() => filterInput.current?.focus()) }}><Search size={14} /></IconButton>
        <Tooltip label={t('shell.project.newSession')}><NavLink to={`/p/${project.id}/c/new`} onClick={onNavigate} aria-label={t('shell.project.newSession')} className="sidebar-add-session"><Plus size={16} /></NavLink></Tooltip>
      </ColumnHeading>
      {filterOpen && <div className="sidebar-session-filter"><Search size={14} /><input ref={filterInput} type="search" value={filter} onChange={(event) => setFilter(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setFilterOpen(false); setFilter('') } }} aria-label={t('shell.sessions.search')} placeholder={t('shell.sessions.search')} /><IconButton label={t('shell.sessions.clear')} size="sm" onClick={() => { setFilter(''); filterInput.current?.focus() }}><X size={13} /></IconButton></div>}
      <div className="nav-column-scroll" data-sidebar-session-scroll={project.id}>
        <ul className="flex flex-col gap-px">
          {active.length > 0 ? <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis, restrictToParentElement]} onDragEnd={onDragEnd} onDragCancel={swallowNextClick}>
            <SortableContext items={matching.map((entry) => entry.id)} strategy={verticalListSortingStrategy}>
              {matching.map((conversation) => <SessionRow key={conversation.id} conversation={conversation} toggleFavorite={toggleFavorite} draggable={!query} onNavigate={onNavigate} />)}
            </SortableContext>
          </DndContext> : <li className="px-3 py-3 text-xs text-ink-faint">{t('shell.conversations.empty')}</li>}
          {query && active.length > 0 && !matching.length && <li role="status" className="px-3 py-3 text-xs text-ink-faint">{t('shell.sessions.noResults')}</li>}
        </ul>
      </div>
      {archived.length > 0 && <div className="sidebar-archives">
        <button type="button" onClick={() => setArchiveOpen((value) => !value)} aria-expanded={archiveOpen} aria-controls={`sidebar-archives-${project.id}`}><Archive size={14} /><span>{t('shell.conversations.archived', { count: String(archived.length) })}</span><ChevronRight size={12} className={cx('ml-auto', archiveOpen && 'rotate-90')} /></button>
        {archiveOpen && <ul id={`sidebar-archives-${project.id}`}>{archived.map((conversation) => <SessionRow key={conversation.id} conversation={conversation} toggleFavorite={toggleFavorite} draggable={false} onNavigate={onNavigate} />)}</ul>}
      </div>}
    </>
  )
}

/**
 * Board summary uses words rather than color dots requiring a legend. Keep two counts: open work
 * (excluding terminal columns also collapsed on boards), and amber review-needed work, the only
 * queue requiring attention.
 */
function BoardCounts({ counts }: { counts: ProjectDto['cardCounts'] }) {
  const t = useTranslate()
  const review = counts.review ?? 0
  const open = (counts.todo ?? 0) + (counts.in_progress ?? 0) + review
  // An empty span keeps the label from becoming the link's last child, which the summary style targets.
  if (open === 0) return <span />
  return (
    <span className="shrink-0 font-medium tracking-normal normal-case tabular-nums">
      {t(open > 1 ? 'shell.project.boardOpen.many' : 'shell.project.boardOpen.one', { count: String(open) })}
      {review > 0 ? <>{' · '}<span className="text-caution">{t('shell.project.boardReview', { count: String(review) })}</span></> : null}
    </span>
  )
}

/**
 * Worktree summary in the board's format: remaining work (uncommitted, unmerged, missing), merged
 * trees with files to sort, and amber cleanup-only trees. Omitted when no extra trees exist because
 * the row matters only through its count.
 */
function WorktreesLine({ projectId }: { projectId: string }) {
  const t = useTranslate()
  const { onNavigate } = useNavChrome()
  const { data } = useWorktreeStatuses(projectId)
  if (!data || data.worktrees.length === 0) return null
  const { pending, leftovers, cleanable } = worktreeCounts(data)
  return (
    <li>
      <NavLink to={`/p/${projectId}#worktrees`} onClick={onNavigate} className="sidebar-project-link">
        <FolderGit2 size={14} className="shrink-0" />
        <span className="flex-1">{t('shell.project.worktrees')}</span>
        {/* Three counts outgrow the default width: wrap between them rather than overflow. */}
        <span className="min-w-0 text-right font-medium tracking-normal normal-case tabular-nums !whitespace-normal">
          {pending > 0 ? <span className="whitespace-nowrap">{t(pending > 1 ? 'shell.project.worktreesPending.many' : 'shell.project.worktreesPending.one', { count: String(pending) })}</span> : null}
          {pending > 0 && leftovers > 0 ? ' · ' : null}
          {leftovers > 0 ? <span className="whitespace-nowrap">{t('shell.project.worktreesLeftovers', { count: String(leftovers) })}</span> : null}
          {(pending > 0 || leftovers > 0) && cleanable > 0 ? ' · ' : null}
          {cleanable > 0 ? <span className="whitespace-nowrap text-caution">{t('shell.project.worktreesCleanable', { count: String(cleanable) })}</span> : null}
        </span>
      </NavLink>
    </li>
  )
}
