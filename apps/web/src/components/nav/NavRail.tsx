import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ProjectDto } from '@sillage/protocol'
import { Activity, FlaskConical, LayoutGrid, LogOut, MessageSquare, MoreHorizontal, Search, Server, Settings } from 'lucide-react'
import { useState, type ComponentPropsWithRef, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { activityTone, type ActivityCounts } from '../../lib/activity'
import { useTranslate, type translate } from '../../lib/i18n'
import type { NavSpace } from '../../lib/nav-space'
import { Logo } from '../Logo'
import { Tooltip, TooltipProvider } from '../ui/Tooltip'
import { UpdateDot } from '../UpdateDot'
import { Menu, MenuItem, MenuLabel, cx } from '../ui'
import { swallowNextClick, useDragSensors } from './shared'

/** Display the modifier key actually used by the platform. */
const SEARCH_HINT = navigator.userAgent.includes('Mac') ? '⌘ K' : 'Ctrl K'

/** "2 awaiting · 1 running", or nothing when the entry is quiet. */
function countsLabel(counts: ActivityCounts, t: typeof translate): string {
  return [
    counts.awaiting > 0 ? t('shell.overview.awaitingCount', { count: counts.awaiting }) : null,
    counts.running > 0 ? t('shell.overview.runningCount', { count: counts.running }) : null,
    counts.unread > 0 ? t('shell.overview.unreadCount', { count: counts.unread }) : null,
  ].filter(Boolean).join(' · ')
}

/**
 * The rail: every entry does the same thing, it selects a space. Icons carry a name and their
 * state in a tooltip, and in their accessible name for keyboard and screen-reader users.
 */
export function NavRail({ space, total, personal, projects, countsOf, hiddenTone, updateNotice, username, onSpace, onReorder, onSearch, onLogout, projectsDialog }: {
  space: NavSpace | null
  /** Across every project and discussion; decisions count as awaiting. */
  total: ActivityCounts
  /** Discussions held outside any project. */
  personal: ActivityCounts
  /** Projects shown as marks, in the account's order. */
  projects: ProjectDto[]
  countsOf: (projectId: string) => ActivityCounts
  /** State of the projects the rail does not show, carried by the entry that lists them all. */
  hiddenTone: ReturnType<typeof activityTone>
  updateNotice: string | undefined
  /** Absent when the edition has no account to sign out of. */
  username: string | undefined
  onSpace: (space: NavSpace) => void
  onReorder: (draggedId: string, overId: string) => void
  onSearch: () => void
  onLogout: () => void
  /** Wraps the "all projects" entry with its dialog. */
  projectsDialog: (trigger: ReactElement) => ReactNode
}) {
  const t = useTranslate()
  const [accountOpen, setAccountOpen] = useState(false)
  const sensors = useDragSensors()
  const totalLabel = countsLabel(total, t)

  const onDragEnd = (event: DragEndEvent) => {
    // Dragging ends with mouseup on the mark, causing a click: suppress it or reordering opens the project.
    swallowNextClick()
    if (event.over && event.active.id !== event.over.id) onReorder(String(event.active.id), String(event.over.id))
  }

  return (
    <TooltipProvider delayDuration={120}>
      <div className="nav-rail" data-nav-rail>
        <span className="nav-rail-brand"><Logo size={22} className="text-accent" /></span>
        <RailEntry label={t('shell.search')} detail={SEARCH_HINT} onClick={onSearch}><Search size={18} /></RailEntry>
        <RailEntry label={t('shell.overview.heading')} detail={totalLabel || t('shell.activity.quiet')} current={space === 'activity'} onClick={() => onSpace('activity')} data-nav-space="activity">
          <Activity size={18} />
          {total.awaiting > 0 ? <span className="nav-rail-badge">{total.awaiting}</span> : total.running > 0 ? <span className="nav-rail-dot nav-tone-running" /> : null}
        </RailEntry>
        <RailEntry label={t('wall.nav')} detail={t('shell.rail.wallHint')} current={space === 'wall'} onClick={() => onSpace('wall')} data-nav-space="wall"><LayoutGrid size={18} /></RailEntry>
        <RailEntry label={t('discussions.title')} detail={countsLabel(personal, t) || t('shell.rail.discussionsHint')} current={space === 'discussions'} onClick={() => onSpace('discussions')} data-nav-space="discussions">
          <MessageSquare size={18} />
          {activityTone(personal) ? <span className={cx('nav-rail-dot', `nav-tone-${activityTone(personal)}`)} /> : null}
        </RailEntry>
        <RailEntry label={t('benchmark.title')} current={space === 'benchmarks'} onClick={() => onSpace('benchmarks')} data-nav-space="benchmarks"><FlaskConical size={18} /></RailEntry>
        <span className="nav-rail-rule" />
        <div className="nav-rail-projects">
          <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis, restrictToParentElement]} onDragEnd={onDragEnd} onDragCancel={swallowNextClick}>
            <SortableContext items={projects.map((project) => project.id)} strategy={verticalListSortingStrategy}>
              {projects.map((project) => (
                <ProjectEntry key={project.id} project={project} counts={countsOf(project.id)} current={space === `project:${project.id}`} onSelect={() => onSpace(`project:${project.id}`)} />
              ))}
            </SortableContext>
          </DndContext>
          {projectsDialog(
            <RailEntry label={t('shell.switcher.all')} detail={t('shell.rail.allHint')} aria-haspopup="dialog" data-nav-projects>
              <MoreHorizontal size={18} />
              {hiddenTone ? <span className={cx('nav-rail-dot', `nav-tone-${hiddenTone}`)} /> : null}
            </RailEntry>,
          )}
        </div>
        <span className="nav-rail-rule" />
        <div className="sidebar-utilities">
          <RailEntry label={t('services.title')} current={space === 'services'} onClick={() => onSpace('services')} data-nav-space="services"><Server size={18} /></RailEntry>
          <RailEntry label={t('shell.settings.label')} detail={updateNotice} current={space === 'settings'} onClick={() => onSpace('settings')} data-nav-space="settings">
            <span className="relative"><Settings size={18} />{updateNotice ? <UpdateDot /> : null}</span>
          </RailEntry>
          {username ? (
            <Menu onOpenChange={setAccountOpen} trigger={
              <RailEntry label={t('shell.account.menu')} detail={username} tooltipDisabled={accountOpen} className="sidebar-account">
                <span className="sidebar-account-avatar">{username.slice(0, 1).toLocaleUpperCase()}</span>
              </RailEntry>
            }>
              <MenuLabel>{username}</MenuLabel><MenuItem icon={<LogOut size={14} />} onSelect={onLogout}>{t('shell.logout')}</MenuItem>
            </Menu>
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  )
}

type RailEntryProps = ComponentPropsWithRef<'button'> & {
  label: string
  /** Second tooltip line, also read out: the entry's state or what it leads to. */
  detail?: string
  current?: boolean
  tooltipDisabled?: boolean
}

function RailEntry({ label, detail, current, tooltipDisabled, className, children, ...props }: RailEntryProps) {
  return (
    <Tooltip side="right" sideOffset={8} disabled={tooltipDisabled} label={<><span className="block font-medium">{label}</span>{detail ? <span className="block text-ink-faint">{detail}</span> : null}</>}>
      <button type="button" {...props} aria-label={detail ? `${label} — ${detail}` : label} aria-current={current ? 'page' : undefined} className={cx('nav-rail-item', className)}>
        {children}
      </button>
    </Tooltip>
  )
}

/** A project in the rail: its image, or its initials on its color when it has none. */
function ProjectEntry({ project, counts, current, onSelect }: { project: ProjectDto; counts: ActivityCounts; current: boolean; onSelect: () => void }) {
  const t = useTranslate()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id })
  const tone = activityTone(counts)
  const initials = project.name.trim().split(/\s+/).slice(0, 2).map((word) => [...word][0] ?? '').join('').toLocaleUpperCase()
  return (
    <RailEntry
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      // The sortable role would announce a generic button; the entry is a navigation target first.
      role={undefined}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      label={project.name}
      detail={countsLabel(counts, t) || undefined}
      current={current}
      onClick={onSelect}
      data-nav-space={`project:${project.id}`}
      className={cx(isDragging && 'relative z-10 opacity-80')}
    >
      {project.image
        // Contain rather than cover: cropped logos become unrecognizable.
        ? <img src={project.image.url} alt="" className="nav-project-mark object-contain" />
        : <span aria-hidden className="nav-project-mark" style={{ '--mark': project.color ?? 'var(--sg-accent)' } as CSSProperties}>{initials}</span>}
      {tone ? <span className={cx('nav-rail-dot', `nav-tone-${tone}`)} /> : null}
    </RailEntry>
  )
}
