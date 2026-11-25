import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ProjectDto } from '@sillage/protocol'
import { Activity, ChartColumn, FlaskConical, LogOut, MessageSquare, Minus, Plus, Search, Server, Settings, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState, type ComponentPropsWithRef, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { activityTone, type ActivityCounts } from '../../lib/activity'
import { useTranslate } from '../../lib/i18n'
import type { NavSpace } from '../../lib/nav-space'
import { PALETTE_SHORTCUT } from '../../lib/palette'
import type { RailProjects } from '../../lib/rail-projects'
import { Logo } from '../Logo'
import { ProjectMark } from '../ProjectMark'
import { Tooltip, TooltipProvider } from '../ui/Tooltip'
import { UpdateDot } from '../UpdateDot'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator, Menu, MenuItem, MenuLabel, cx } from '../ui'
import { countsLabel, swallowNextClick, useContextMenuEnabled, useDragSensors } from './shared'
import { tourAnchor } from '../tour/steps'

/** Longest fade at an end of the scrolled projects, in pixels. */
const FADE = 22

/**
 * The rail: every entry does the same thing, it selects a space. Icons carry a name and their
 * state in a tooltip, and in their accessible name for keyboard and screen-reader users.
 */
export function NavRail({ space, total, benchmarks, personal, rail, countsOf, hidden, updateNotice, username, onSpace, onProjectSettings, onReorder, onSearch, onLogout, addProject }: {
  space: NavSpace | null
  /** Across every project and discussion; decisions count as awaiting. */
  total: ActivityCounts
  /** Runs waiting for the user, and benchmarks still running. */
  benchmarks: ActivityCounts
  /** Discussions held outside any project. */
  personal: ActivityCounts
  /** Projects shown as marks, and what adds or removes one. */
  rail: RailProjects
  countsOf: (projectId: string) => ActivityCounts
  /** State of the projects the rail does not show, carried by the entry that adds them. */
  hidden: ActivityCounts
  updateNotice: string | undefined
  /** Absent when the edition has no account to sign out of. */
  username: string | undefined
  onSpace: (space: NavSpace) => void
  onProjectSettings: (projectId: string) => void
  onReorder: (draggedId: string, overId: string) => void
  onSearch: () => void
  onLogout: () => void
  /**
   * Gives the entry that adds a project its panel. The panel is placed against the projects' zone,
   * built around the wired entry: the entry moves down with each project added, and would take
   * the panel and its rows with it.
   */
  addProject: (trigger: ReactElement, zone: (entry: ReactElement) => ReactElement) => ReactNode
}) {
  const t = useTranslate()
  const sensors = useDragSensors()
  const totalLabel = countsLabel(total, t)
  const hiddenTone = activityTone(hidden)
  const [list, ends] = useHiddenEnds(rail.kept.length, space)

  const onDragEnd = (event: DragEndEvent) => {
    // Dragging ends with mouseup on the mark, causing a click: suppress it or reordering opens the project.
    swallowNextClick()
    if (event.over && event.active.id !== event.over.id) onReorder(String(event.active.id), String(event.over.id))
  }
  const entryOf = (project: ProjectDto) => ({
    project,
    counts: countsOf(project.id),
    current: space === `project:${project.id}`,
    canRemove: rail.canRemove,
    onSelect: () => onSpace(`project:${project.id}`),
    onKeep: (kept: boolean) => rail.setKept(project, kept),
    onSettings: () => onProjectSettings(project.id),
  })

  return (
    <TooltipProvider delayDuration={120}>
      <div className="nav-rail" data-nav-rail {...tourAnchor('rail')}>
        <span className="nav-rail-brand"><Logo size={22} className="text-accent" /></span>
        <RailEntry label={t('shell.search')} detail={PALETTE_SHORTCUT} onClick={onSearch} {...tourAnchor('palette')}><Search size={18} /></RailEntry>
        <RailEntry label={t('shell.overview.heading')} detail={totalLabel || t('shell.activity.quiet')} current={space === 'activity'} onClick={() => onSpace('activity')} data-nav-space="activity">
          <Activity size={18} />
          {total.awaiting > 0 ? <span className="nav-rail-badge">{total.awaiting}</span> : total.running > 0 ? <span className="nav-rail-dot nav-tone-running" /> : null}
        </RailEntry>
        <RailEntry label={t('discussions.title')} detail={countsLabel(personal, t) || t('shell.rail.discussionsHint')} current={space === 'discussions'} onClick={() => onSpace('discussions')} data-nav-space="discussions">
          <MessageSquare size={18} />
          {activityTone(personal) ? <span className={cx('nav-rail-dot', `nav-tone-${activityTone(personal)}`)} /> : null}
        </RailEntry>
        <RailEntry label={t('benchmark.title')} detail={countsLabel(benchmarks, t) || undefined} current={space === 'benchmarks'} onClick={() => onSpace('benchmarks')} data-nav-space="benchmarks">
          <FlaskConical size={18} />
          {activityTone(benchmarks) ? <span className={cx('nav-rail-dot', `nav-tone-${activityTone(benchmarks)}`)} /> : null}
        </RailEntry>
        <span className="nav-rail-rule" />
        {addProject(
          <RailEntry label={t('shell.rail.add')} detail={hiddenTone ? t('shell.rail.hidden', { state: countsLabel(hidden, t) }) : t('shell.rail.addHint')} data-nav-add-project>
            <span className="nav-rail-add"><Plus size={16} /></span>
            {hiddenTone ? <span className={cx('nav-rail-dot', `nav-tone-${hiddenTone}`)} /> : null}
          </RailEntry>,
          (entry) => (
            <div className="nav-rail-projects">
              {/* Only the kept projects scroll: what adds one stays in reach however long the list grows. */}
              <div ref={list} className="nav-rail-projects-list" data-more-above={ends.above > 0 || undefined} data-more-below={ends.below > 0 || undefined}
                style={{ '--fade-above': `${ends.above}px`, '--fade-below': `${ends.below}px` } as CSSProperties}>
                <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis, restrictToParentElement]} onDragEnd={onDragEnd} onDragCancel={swallowNextClick}>
                  <SortableContext items={rail.kept.map((project) => project.id)} strategy={verticalListSortingStrategy}>
                    {rail.kept.map((project) => <SortableProject key={project.id} {...entryOf(project)} />)}
                  </SortableContext>
                </DndContext>
              </div>
              {rail.visiting ? <ProjectEntry key={rail.visiting.id} {...entryOf(rail.visiting)} visiting /> : null}
              {entry}
            </div>
          ),
        )}
        <span className="nav-rail-rule" />
        <div className="sidebar-utilities">
          <RailEntry label={t('services.title')} current={space === 'services'} onClick={() => onSpace('services')} data-nav-space="services"><Server size={18} /></RailEntry>
          <RailEntry label={t('consumption.title')} detail={t('consumption.rail.hint')} current={space === 'consumption'} onClick={() => onSpace('consumption')} data-nav-space="consumption"><ChartColumn size={18} /></RailEntry>
          <RailEntry label={t('shell.settings.label')} detail={updateNotice} current={space === 'settings'} onClick={() => onSpace('settings')} data-nav-space="settings">
            <span className="relative"><Settings size={18} />{updateNotice ? <UpdateDot /> : null}</span>
          </RailEntry>
          {username ? (
            <Menu trigger={
              <RailEntry label={t('shell.account.menu')} detail={username} className="sidebar-account">
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

/**
 * How much each end of the list hides, capped at the fade that says so; and the open project
 * brought back into view, since a rail that scrolled it away would show no current entry at all.
 */
function useHiddenEnds(count: number, space: NavSpace | null) {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [ends, setEnds] = useState({ above: 0, below: 0 })
  useEffect(() => {
    if (!node) return
    const measure = () => setEnds((current) => {
      const above = Math.min(FADE, Math.round(node.scrollTop))
      const below = Math.min(FADE, Math.max(0, Math.round(node.scrollHeight - node.clientHeight - node.scrollTop)))
      return current.above === above && current.below === below ? current : { above, below }
    })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    node.addEventListener('scroll', measure, { passive: true })
    return () => { observer.disconnect(); node.removeEventListener('scroll', measure) }
  }, [node, count])
  useEffect(() => {
    node?.querySelector('[aria-current=page]')?.scrollIntoView({ block: 'nearest' })
  }, [node, space])
  return [setNode, ends] as const
}

type RailEntryProps = ComponentPropsWithRef<'button'> & {
  label: string
  /** Second tooltip line, also read out: the entry's state or what it leads to. */
  detail?: string
  /** Third tooltip line, for pointer users only: a gesture the entry answers to. */
  hint?: string
  current?: boolean
}

function RailEntry({ label, detail, hint, current, className, children, ...props }: RailEntryProps) {
  // A menu or panel opened from the entry sets its state on it: the tooltip would cover what just opened.
  const open = (props as { 'data-state'?: string })['data-state'] === 'open'
  return (
    <Tooltip side="right" sideOffset={8} disabled={open || undefined} label={<><span className="block font-medium">{label}</span>{detail ? <span className="block text-ink-faint first-letter:uppercase">{detail}</span> : null}{hint ? <span className="block text-ink-faint">{hint}</span> : null}</>}>
      <button type="button" {...props} aria-label={detail ? `${label} — ${detail}` : label} aria-current={current ? 'page' : undefined} className={cx('nav-rail-item', className)}>
        {children}
      </button>
    </Tooltip>
  )
}

type ProjectEntryProps = Omit<ComponentPropsWithRef<'button'>, 'onSelect'> & {
  project: ProjectDto
  counts: ActivityCounts
  current: boolean
  /** Open without being kept in the rail: it leaves with the next space chosen. */
  visiting?: boolean
  canRemove: boolean
  onSelect: () => void
  onKeep: (kept: boolean) => void
  onSettings: () => void
}

/** A project in the rail: its mark and one state, and by right click what keeps it there or not. */
function ProjectEntry({ project, counts, current, visiting = false, canRemove, onSelect, onKeep, onSettings, className, ...props }: ProjectEntryProps) {
  const t = useTranslate()
  const contextMenu = useContextMenuEnabled()
  const tone = activityTone(counts)
  return (
    <ContextMenu disabled={!contextMenu} trigger={
      <RailEntry
        {...props}
        label={project.name}
        detail={[countsLabel(counts, t), visiting ? t('shell.rail.visiting') : null].filter(Boolean).join(' · ') || undefined}
        hint={visiting && contextMenu ? t('shell.rail.visitingHint') : undefined}
        current={current}
        onClick={onSelect}
        data-nav-space={`project:${project.id}`}
        data-nav-visiting={visiting || undefined}
        className={className}
      >
        <ProjectMark project={project} />
        {tone ? <span className={cx('nav-rail-dot', `nav-tone-${tone}`)} /> : null}
      </RailEntry>
    }>
      <ContextMenuItem icon={<SlidersHorizontal size={14} />} onSelect={onSettings}>{t('shell.project.settings')}</ContextMenuItem>
      <ContextMenuSeparator />
      {visiting
        ? <ContextMenuItem icon={<Plus size={14} />} onSelect={() => onKeep(true)}>{t('shell.rail.add')}</ContextMenuItem>
        : <ContextMenuItem icon={<Minus size={14} />} disabled={!canRemove} onSelect={() => onKeep(false)}>{t('shell.rail.remove')}</ContextMenuItem>}
    </ContextMenu>
  )
}

/** A kept project, which drag reorders. */
function SortableProject(props: ProjectEntryProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.project.id })
  return (
    <ProjectEntry
      {...props}
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      // The sortable role would announce a generic button; the entry is a navigation target first.
      role={undefined}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx(isDragging && 'relative z-10 opacity-80')}
    />
  )
}
