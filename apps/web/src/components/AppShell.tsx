import { useCliUpdateNotice } from '../lib/agents'
import { conversationPath } from '@sillage/protocol'
import { sessionReference } from '@sillage/protocol'
import { useCopy } from '../lib/clipboard'
import { Tooltip, TooltipButton } from './ui/Tooltip'
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  Link2,
  ChevronRight,
  FolderPlus,
  Brain,
  FolderOpen,
  MessageSquare,
  LogOut,
  MoreHorizontal,
  Palette,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  SlidersHorizontal,
  SquareKanban,
  SquareTerminal,
  Star,
  Trash2,
  Users,
  X,
  FolderGit2,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { NavLink, useMatch, useNavigate } from 'react-router-dom'
import { Outlet } from 'react-router-dom'
import type { ConversationDto, ProjectDto, ScheduledTaskDto } from '@sillage/protocol'
import {
  useAllConversations,
  useArchiveConversation,
  useDeleteConversation,
  useRenameConversation,
  useReorderConversations,
  useToggleFavorite,
} from '../lib/conversations'
import {
  useLiveBackground,
  useLiveLoops,
  useLiveMetrics,
  useLiveSeq,
  useLiveStatus,
  useRefreshLists,
  useRevalidateLists,
  useStatusFeed,
} from '../lib/conversation-status'
import { isUnread, useHasUnread } from '../lib/reads'
import { useUpdateCollapsedProjects, useUserSettings } from '../lib/user-settings'
import { useAppearanceSync } from '../lib/appearance-sync'
import { buildSidebarSignals, presentSignal } from '../lib/signals'
import { SignalDot } from './chat/Signals'
import { SessionPreview } from './SessionPreview'
import { compactRelativeDate, relativeDate } from '../lib/dates'
import '../styles/sidebar.css'
import { useProjects, useReorderProjects, useUpdateProject } from '../lib/projects'
import { projectViewPath, useProjectView } from '../lib/project-view'
import { useWorktreeStatuses, worktreeCounts } from '../lib/worktrees'
import { useRememberContext } from '../lib/last-context'
import { SidebarActivity } from './SidebarActivity'
import { Toaster } from './Toaster'
import { DecisionDialog } from './decisions/DecisionDialog'
import { SidebarDecisions } from './decisions/SidebarDecisions'
import { useDecisionsLive } from '../lib/decisions'
import { SidebarSchedules } from './SidebarSchedules'
import { useSchedules } from '../lib/schedules'
import { ProjectAvatar } from './ProjectAvatar'
import { ProjectSwitcher } from './ProjectSwitcher'
import { useProjectVisits } from '../lib/project-visits'
import {
  restoreSidebarWidth,
  setSidebarHidden,
  setSidebarWidth,
  useSidebarHidden,
} from '../lib/sidebar'
import { useFileDropGuard } from '../lib/file-drop'
import { useTranslate } from '../lib/i18n'
import { resizeHandle } from '../lib/resize-handle'
import { useMediaQuery, useVisualViewport } from '../lib/viewport'
import { PROJECT_COLORS } from '../lib/project-colors'
import { useCapability } from '../lib/instance'
import { useCurrentUser, useLogout } from '../lib/session'
import { AgentIcon } from './AgentIcon'
import { CommandPalette } from './CommandPalette'
import { Logo } from './Logo'
import { UpdatePrompt } from './UpdatePrompt'
import { UpdateDot } from './UpdateDot'
import { useUpdateNotice } from '../lib/system'
import { MobileNavigationButton, MobileNavigationContext } from './MobileNavigation'
import { PullToRefresh } from './PullToRefresh'
import {
  Banner,
  Button,
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSwatch,
  IconButton,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSwatch,
  MenuSwatchRow,
  cx,
} from './ui'

/**
 * Touch has no right click and long-press already starts row dragging: omit context menus; the
 * always-visible ellipsis button suffices.
 */
function useContextMenuEnabled(): boolean {
  return !useMediaQuery('(pointer: coarse)')
}

/** Display the modifier key actually used by the platform. */
const SEARCH_HINT = navigator.userAgent.includes('Mac') ? '⌘ K' : 'Ctrl K'

/**
 * Suppress the click immediately following drag-and-drop. Capture before links, then remove on the
 * next event-loop tick: if no click follows the drag, never swallow the next legitimate one.
 */
function swallowNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }

  window.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
}

/**
 * Rename field opened by double-clicking the name. Select text on opening because users usually
 * replace a CLI-suggested name; an end-position cursor forced manual deletion.
 */
function RenameInput({
  value,
  onCommit,
  onCancel,
  className,
}: {
  value: string
  onCommit: (next: string) => void
  onCancel: () => void
  className: string
}) {
  const [draft, setDraft] = useState(value)

  return (
    <input
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onCommit(draft)
        if (event.key === 'Escape') onCancel()
      }}
      className={className}
    />
  )
}

/**
 * Mouse uses a movement threshold so link clicks remain clicks. Touch uses long-press so dragging
 * does not steal list scrolling.
 */
function useDragSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  )
}

/**
 * Desktop has a persistent sidebar; mobile presents the same navigation component as a full-screen
 * drawer.
 */
export function AppShell() {
  useDecisionsLive()
  const t = useTranslate()
  useAppearanceSync()
  const [navOpen, setNavOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const pwa = useCapability('pwa')
  const hidden = useSidebarHidden()
  const aside = useRef<HTMLElement>(null)
  const wide = useMediaQuery('(min-width: 48rem)')
  const conversationRoute = useMatch('/p/:projectId/c/:conversationId')
  const discussionRoute = useMatch('/discussions/:conversationId')
  const boardRoute = useMatch('/p/:projectId/board')
  const servicesRoute = useMatch('/services')
  const schedulesRoute = useMatch('/p/:projectId/schedules')
  const automationRoute = useMatch('/p/:projectId/schedules/:taskId')
  const contextualHeader = Boolean(conversationRoute || discussionRoute || boardRoute || servicesRoute || schedulesRoute || automationRoute)
  const navInactive = wide ? hidden : !navOpen
  useVisualViewport()
  useFileDropGuard()
  useRememberContext()
  const revalidateLists = useRevalidateLists()

  useEffect(restoreSidebarWidth, [])

  useEffect(() => {
    if (!wide && navOpen) revalidateLists()
  }, [wide, navOpen, revalidateLists])

  useEffect(() => {
    if (wide || !navOpen) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    aside.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {
      const target = previous?.isConnected && !previous.closest('[inert]')
        ? previous
        : document.querySelector<HTMLElement>('[data-navigation-trigger]')
      target?.focus()
    }
  }, [wide, navOpen])

  useEffect(() => {
    if (wide && hidden && aside.current?.contains(document.activeElement)) {
      document.querySelector<HTMLElement>('[data-sidebar-restore]')?.focus()
    }
  }, [wide, hidden])

  // Global shortcut: open the palette from any view, including while the composer has focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      setSearchOpen((value) => !value)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /**
   * Sidebar starts at the window's left edge, so pointer x is the desired width with no initial
   * offset to retain.
   */
  const handle = resizeHandle({
    widthAt: (clientX) => clientX,
    current: () => aside.current?.getBoundingClientRect().width ?? null,
    apply: setSidebarWidth,
  })

  return (
    /**
     * Fixed app layer sized by app-layer. With the keyboard open it follows the visual viewport and
     * offsets by viewport-top, moving above the keyboard instead of hiding the composer.
     */
    <MobileNavigationContext.Provider value={() => setNavOpen(true)}>
    <div className="app-layer flex overflow-hidden text-ink">
      <aside
        ref={aside}
        inert={navInactive}
        aria-hidden={navInactive}
        role={!wide && navOpen ? 'dialog' : undefined}
        aria-modal={!wide && navOpen ? true : undefined}
        aria-label={t('shell.nav.label')}
        onKeyDown={(event) => {
          const node = aside.current
          if (wide || !navOpen || event.defaultPrevented || !node?.contains(event.target as Node)) return
          if (event.key === 'Escape') {
            event.preventDefault()
            setNavOpen(false)
          }
          if (event.key !== 'Tab') return
          const targets = Array.from(node.querySelectorAll<HTMLElement>(
            'button, a[href], input, select, textarea, [tabindex]',
          )).filter((item) => item.tabIndex >= 0 && !item.matches(':disabled') && item.getClientRects().length > 0)
          const first = targets[0]
          const last = targets.at(-1)
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
        className={cx(
          // Absolute rather than fixed: reference the app layer above so the drawer follows the
          // visual viewport. Fill mobile width because 16.5rem truncated titles after a few words;
          // nothing behind the overlay needs to remain visible.
          'absolute inset-y-0 left-0 z-30 w-full shrink-0',
          'md:w-[var(--sidebar-desktop-width)]',
          'surface border-r border-line pt-safe',
          // Mobile overlays need only translation to enter and leave. Desktop occupies a flex
          // column, so collapse its margin or translation would leave empty space. Transition
          // translate rather than transform: Tailwind v4 uses the separate CSS translate property,
          // so transform transitions did nothing and mobile drawers jumped.
          'transition-[translate,margin] duration-200 ease-out',
          // md:left-auto prevents sticky left:0 pinning the element to the viewport and visually
          // canceling negative collapse margins even though space was released.
          'md:relative md:h-full md:translate-x-0',
          navOpen ? 'translate-x-0' : '-translate-x-full',
          hidden ? 'md:-ml-[var(--sidebar-desktop-width)]' : 'md:ml-0',
        )}
      >
        <Sidebar
          onNavigate={() => setNavOpen(false)}
          onClose={() => setNavOpen(false)}
          onCollapse={() => setSidebarHidden(true)}
          onSearch={() => {
            setNavOpen(false)
            setSearchOpen(true)
          }}
        />

        {/*
         * Right-edge resize handle hidden when collapsed, or it would sit over the restore button
         * resizing an invisible sidebar.
         */}
        {hidden ? null : (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('shell.nav.resize.aria')}
            tabIndex={0}
            onPointerDown={handle.onPointerDown}
            onKeyDown={handle.onKeyDown}
            className={cx(
              'absolute inset-y-0 -right-1 z-10 hidden w-2 cursor-col-resize md:block',
              // Show the resize line only on hover: the sidebar border already suffices at rest and
              // a permanent extra line would double it.
              'after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2',
              'after:transition-colors hover:after:bg-accent focus-visible:after:bg-accent',
              'outline-none',
            )}
          />
        )}
      </aside>

      {hidden ? (
        <div className="absolute top-2 left-2 z-30 hidden md:block">
          <IconButton data-sidebar-restore label={t('shell.nav.show')} onClick={() => setSidebarHidden(false)}>
            <PanelLeft size={18} />
          </IconButton>
        </div>
      ) : null}

      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
      {/* Mounting the prompt registers the service worker: without PWA, mount neither. */}
      {pwa ? <UpdatePrompt /> : null}

      {/*
       * No gutter: restore buttons overlay top-left corners and header views reserve space with
       * useSidebarHidden. Offsetting the entire column left an empty full-height strip.
       */}
      <div
        inert={!wide && navOpen}
        className={cx('flex min-w-0 flex-1 flex-col', contextualHeader && 'pt-safe md:pt-0')}
      >
        {!contextualHeader ? (
        <header
          className={cx(
            'header-bar flex shrink-0 items-center gap-1 px-2',
            'border-b border-line bg-canvas/85 backdrop-blur-md md:hidden',
          )}
        >
          <MobileNavigationButton />
          <Logo size={18} className="text-accent" />
          <span className="font-medium">Sillage</span>
        </header>
        ) : null}

        {/* The root layer never scrolls: views own scrolling. Supply it here for settings pages without their own. */}
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      {/* Outside the main column so decisions and toasts overlay every view including sidebar. */}
      <DecisionDialog />
      <Toaster />
    </div>
    </MobileNavigationContext.Provider>
  )
}

type FavoriteMutation = ReturnType<typeof useToggleFavorite>

function Sidebar({
  onNavigate,
  onClose,
  onCollapse,
  onSearch,
}: {
  onNavigate: () => void
  onClose: () => void
  onCollapse: () => void
  onSearch: () => void
}) {
  const t = useTranslate()
  const { data: user } = useCurrentUser()
  const { data: projects } = useProjects()
  const { data: conversations } = useAllConversations()
  const { data: schedules } = useSchedules()
  // Exclude scheduled runs from activity: autonomous tasks are not followed sessions and their own
  // section already reports state.
  const attended = useMemo(() => conversations?.filter((entry) => !entry.scheduleId), [conversations])
  // One mutation for both favorite appearances. Keep errors visible even if optimistic removal
  // hides the favorite row.
  const toggleFavorite = useToggleFavorite()
  const logout = useLogout()
  // Without a password, logout would leave an unusable login page.
  const passwordAuth = useCapability('passwordAuth')
  const appUpdateNotice = useUpdateNotice()
  const cliUpdateNotice = useCliUpdateNotice()
  const updateNotice = appUpdateNotice || cliUpdateNotice
  const navigate = useNavigate()
  const routeProjectId = useMatch('/p/:projectId/*')?.params.projectId
  const visits = useProjectVisits(user?.id ?? '')
  const [allProjects, setAllProjects] = useState(false)
  const selectedProject = projects?.find((project) => project.id === routeProjectId)
    ?? projects?.find((project) => project.id === visits[0]?.projectId)
    ?? projects?.[0]
  const visibleProjects = allProjects ? projects : projects?.filter((project) => project.id === selectedProject?.id)
  const reorder = useReorderProjects()
  const sensors = useDragSensors()
  useStatusFeed()
  const { refreshing, refresh } = useRefreshLists()
  const nav = useRef<HTMLElement>(null)

  /**
   * Collapse follows the account rather than browser: a project is collapsed because it is not
   * current work, across devices. Start expanded until settings load to avoid a closed-list flash
   * on every load.
   */
  const { data: settings } = useUserSettings()
  const setCollapsedProjects = useUpdateCollapsedProjects()
  const collapsed = useMemo(
    () => new Set(settings?.collapsedProjects ?? []),
    [settings?.collapsedProjects],
  )
  const toggle = (projectId: string) => {
    const next = new Set(collapsed)
    if (!next.delete(projectId)) next.add(projectId)
    setCollapsedProjects.mutate([...next])
  }

  /**
   * Temporarily collapse all conversations while dragging projects. Projects with thirty
   * conversations exceed screen height and make dragging impractical. Preserve user-selected
   * collapsed state separately.
   */
  const [dragging, setDragging] = useState(false)

  /**
   * Account bookmarks across all projects, including archived threads: automatic archiving should
   * not hide deliberately saved conversations, precisely where shortcuts help.
   */
  const favorites = useMemo(
    () => (conversations ?? []).filter((entry) => entry.favorite),
    [conversations],
  )
  const [favoritesOpen, setFavoritesOpen] = useState(false)
  const [editingProject, setEditingProject] = useState(false)
  const updateSelectedProject = useUpdateProject()

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(false)
    // Dragging ends with mouseup on the project link, causing a browser click: suppress it or
    // reordering opens the moved project.
    swallowNextClick()

    const { active, over } = event
    if (!over || active.id === over.id) return

    const ids = (projects ?? []).map((project) => project.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from === -1 || to === -1) return

    reorder.mutate(arrayMove(ids, from, to))
  }

  return (
    <div className="sidebar-layout">
      <div className="sidebar-brand">
        <Logo size={21} className="text-accent" /><span className="text-[0.9375rem] font-semibold tracking-tight">Sillage</span>
        <span className="ml-auto md:hidden"><IconButton label={t('shell.nav.close')} onClick={onClose}><X size={18} /></IconButton></span>
        <span className="ml-auto hidden md:block"><IconButton label={t('shell.nav.collapse')} onClick={onCollapse}><PanelLeftClose size={18} /></IconButton></span>
      </div>
      <button type="button" onClick={onSearch} className="sidebar-search">
        <Search size={15} /><span className="flex-1 text-left">{t('shell.search')}</span><kbd className="hidden text-[0.625rem] md:block">{SEARCH_HINT}</kbd>
      </button>
      {toggleFavorite.isError && <div className="shrink-0 px-2 pb-2"><Banner>
        <span className="block">{t('shell.favorites.error')}</span><span className="mt-1 block text-xs">{toggleFavorite.error.message}</span>
        <span className="mt-1 flex items-center gap-1"><Button variant="ghost" size="sm" onClick={() => { if (toggleFavorite.variables) toggleFavorite.mutate(toggleFavorite.variables) }}>{t('editor.retry')}</Button><IconButton size="sm" label={t('common.close')} onClick={() => toggleFavorite.reset()}><X size={14} /></IconButton></span>
      </Banner></div>}
      <nav ref={nav} className="sidebar-navigation" aria-label={t('shell.nav.label')}>
        <PullToRefresh target={nav} refreshing={refreshing} onRefresh={refresh} />
        <SidebarActivity conversations={attended} projects={projects} onNavigate={onNavigate}>
          <div className="sidebar-global-links">
            <button type="button" className="sidebar-global-link" onClick={() => setFavoritesOpen(value => !value)} aria-expanded={favoritesOpen} aria-controls="sidebar-favorites"><Star size={14} /><span>{t('shell.favorites.heading')}</span><span className="ml-auto tabular-nums text-ink-faint">{favorites.length}</span></button>
            <SidebarDecisions onNavigate={onNavigate} />
          </div>
          {favoritesOpen && <div id="sidebar-favorites" className="sidebar-favorites"><ul>
            {favorites.map(conversation => <ConversationRow key={conversation.id} conversation={conversation} toggleFavorite={toggleFavorite} draggable={false} onNavigate={onNavigate} />)}
            {!favorites.length && <li className="px-3 py-3 text-xs text-ink-faint">{t('shell.favorites.empty')}</li>}
          </ul></div>}
          <PersonalDiscussions conversations={conversations ?? []} toggleFavorite={toggleFavorite} onNavigate={onNavigate} />
          <div className="sidebar-project-switcher">
        <ProjectSwitcher onNavigate={onNavigate} key={user?.id ?? ''} userId={user?.id ?? ''} projects={projects ?? []} selected={selectedProject}
          nameEditor={editingProject && selectedProject ? <RenameInput value={selectedProject.name} onCancel={() => setEditingProject(false)} onCommit={(draft) => {
            setEditingProject(false)
            const name = draft.trim()
            if (name && name !== selectedProject.name) updateSelectedProject.mutate({ id: selectedProject.id, name })
          }} className="h-9 min-w-0 flex-1 rounded border border-accent bg-sunken px-2 text-sm outline-none" /> : undefined}
          actions={<Menu trigger={<IconButton label={selectedProject && !allProjects ? t('shell.project.actions', { name: selectedProject.name }) : t('shell.projects.heading')} size="sm"><MoreHorizontal size={16} /></IconButton>}>
            {!allProjects && selectedProject?.isOwner && <ProjectMenuItems variant="dropdown" project={selectedProject} onRename={() => setEditingProject(true)} onNavigate={onNavigate} />}
            {!allProjects && selectedProject && !selectedProject.isOwner && <MenuItem icon={<SlidersHorizontal size={14} />} onSelect={() => { navigate(`/p/${selectedProject.id}`); onNavigate() }}>{t('shell.project.settings')}</MenuItem>}
            {!allProjects && selectedProject && <MenuSeparator />}
            <MenuItem icon={<RefreshCw size={14} />} disabled={refreshing} onSelect={refresh}>{t('shell.refresh')}</MenuItem>
            <MenuItem icon={<FolderPlus size={14} />} onSelect={() => { navigate('/projects/new'); onNavigate() }}>{t('shell.projects.add')}</MenuItem>
          </Menu>}
          all={allProjects} recent={visits.map((entry) => entry.projectId)} onAll={() => setAllProjects(true)}
          onSelect={(project, fallback) => {
            setAllProjects(false)
            const visit = visits.find((entry) => entry.projectId === project.id)
            const conversationId = visit?.path.match(/\/c\/([\w-]+)$/)?.[1]
            const valid = !conversationId || conversationId === 'new' || conversations?.some((entry) => entry.id === conversationId && entry.projectId === project.id)
            navigate(visit && valid ? visit.path : fallback)
            onNavigate()
          }} />
          </div>
          <div className="sidebar-project-area">
        {projects && projects.length > 0 ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragStart={() => setDragging(true)}
            onDragEnd={onDragEnd}
            onDragCancel={() => {
              setDragging(false)
              swallowNextClick()
            }}
          >
            <SortableContext
              items={projects.map((project) => project.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className={cx('sidebar-projects', !allProjects && 'sidebar-projects-focused')}>
                {visibleProjects?.map((project) => (
                  <ProjectGroup
                    key={project.id}
                    project={project}
                    toggleFavorite={toggleFavorite}
                    conversations={(conversations ?? []).filter((c) => c.projectId === project.id)}
                    schedules={(schedules ?? []).filter((task) => task.projectId === project.id)}
                    focused={!allProjects}
                    open={!allProjects || (!dragging && !collapsed.has(project.id))}
                    // User-requested collapse, which open alone cannot express: dragging closes all
                    // projects and would otherwise light every unread aggregate during the gesture.
                    collapsed={allProjects && collapsed.has(project.id)}
                    onToggle={() => toggle(project.id)}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        ) : (
          <p className="px-2.5 py-1 text-sm text-ink-faint">{t('shell.projects.empty')}</p>
        )}
          </div>
        </SidebarActivity>
      </nav>
      <div className="sidebar-utilities pb-safe">
        <SidebarRow to="/services" onClick={onNavigate}><Server size={15} /><span>{t('services.title')}</span></SidebarRow>
        <SidebarRow to="/settings" end={false} onClick={onNavigate}><span className="relative"><Settings size={15} />{updateNotice && <UpdateDot />}</span><span>{t('shell.settings.label')}</span>{updateNotice && <span className="sr-only">{t('about.badge.updateAvailable')}</span>}</SidebarRow>
        {passwordAuth && <Menu trigger={<button type="button" className="sidebar-account" aria-label={t('shell.account.menu')}>{user?.username.slice(0, 1).toLocaleUpperCase()}</button>}>
          <MenuLabel>{user?.username}</MenuLabel><MenuItem icon={<LogOut size={14} />} onSelect={() => logout.mutate()}>{t('shell.logout')}</MenuItem>
        </Menu>}
      </div>
    </div>
  )
}

interface ProjectGroupProps {
  project: ProjectDto
  toggleFavorite: FavoriteMutation
  /** Active and archived together: the group separates them itself. */
  conversations: ConversationDto[]
  schedules: ScheduledTaskDto[]
  open: boolean
  focused?: boolean
  /** User-collapsed independently of temporary drag closure. */
  collapsed: boolean
  onToggle: () => void
  onNavigate: () => void
}

function ProjectGroup({
  project,
  toggleFavorite,
  conversations,
  schedules,
  open,
  focused = false,
  collapsed,
  onToggle,
  onNavigate,
}: ProjectGroupProps) {
  const t = useTranslate()
  const updateProject = useUpdateProject()
  const reorder = useReorderConversations(project.id)
  // Exclude scheduled runs from active and archived lists: they live beneath their task in Scheduled.
  const active = useMemo(() => conversations.filter((c) => !c.archivedAt && !c.scheduleId), [conversations])
  const archived = useMemo(() => conversations.filter((c) => c.archivedAt && !c.scheduleId), [conversations])
  const scheduled = useMemo(() => conversations.filter((c) => c.scheduleId), [conversations])
  const [archiveOpen, setArchiveOpen] = useState(false)
  // Reopen the project's remembered view: board where used, otherwise a new conversation.
  const view = useProjectView(project.id)
  // Collapsed projects aggregate row unread state so completed turns remain visible. Exclude the
  // open thread as its own row does, or collapsing its project would flash unread at every turn end
  // until the cursor is sent.
  const openConversationId = useMatch('/p/:projectId/c/:conversationId')?.params.conversationId
  const hasUnread = useHasUnread(active, openConversationId)

  const contextMenu = useContextMenuEnabled()
  const [showAll, setShowAll] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const filterInput = useRef<HTMLInputElement>(null)
  const { data: treeStatus } = useWorktreeStatuses(project.id)
  const query = filter.trim().toLocaleLowerCase()
  const matching = active.filter(entry => !query || entry.title.toLocaleLowerCase().includes(query)
    || treeStatus?.worktrees.some(tree => tree.conversations.some(link => link.id === entry.id) && `${tree.name} ${tree.branch ?? ''}`.toLocaleLowerCase().includes(query)))
  const visibleActive = focused && !showAll && !query
    ? matching.filter((entry, index) => index < 10 || entry.id === openConversationId || entry.favorite)
    : matching
  const [editing, setEditing] = useState(false)

  const sensors = useDragSensors()

  /**
   * Projects are draggable only by their header. Whole-element listeners would include conversation
   * lists with their own drag context and start both drags on conversation presses.
   */
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id, disabled: editing || focused })

  const commitRename = (draft: string) => {
    setEditing(false)
    const name = draft.trim()
    if (name && name !== project.name) updateProject.mutate({ id: project.id, name })
  }

  const onDragEnd = (event: DragEndEvent) => {
    // Dragging ends with mouseup on the link, causing a click: suppress it or reordering opens the conversation.
    swallowNextClick()

    const { active: dragged, over } = event
    if (!over || dragged.id === over.id) return

    // Resolve the drop against the rows on screen, then place the row in the full list next to
    // the one it landed on: the focused view hides rows beyond the first ten, so visible and
    // stored indexes diverge and an arrayMove on stored indexes sent rows far from the drop.
    const visible = visibleActive.map((entry) => entry.id)
    const from = visible.indexOf(String(dragged.id))
    const to = visible.indexOf(String(over.id))
    if (from === -1 || to === -1) return

    const ids = active.map((entry) => entry.id).filter((id) => id !== dragged.id)
    const anchor = ids.indexOf(String(over.id))
    if (anchor === -1) return
    ids.splice(to > from ? anchor + 1 : anchor, 0, String(dragged.id))

    reorder.mutate(ids)
  }

  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx('sidebar-project', focused && 'sidebar-project-focused', isDragging && 'relative z-10 bg-surface-high opacity-90')}>
      {!focused && <>
      <ContextMenu
        disabled={!contextMenu || !project.isOwner || editing}
        trigger={
      <div
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        // Projects use bold full ink; conversations use smaller muted text. Without this hierarchy
        // both navigation levels looked like one flat list.
        className="group flex h-11 items-center gap-0.5 rounded-md pr-1 text-ink transition-colors hover:bg-surface-high md:h-9 pointer-coarse:h-11"
      >
        {!focused && <TooltipButton
          type="button"
          onClick={onToggle}
          aria-label={
            open
              ? t('shell.project.collapse', { name: project.name })
              : t('shell.project.expand', { name: project.name })
          }
          aria-expanded={open}
          className="flex size-11 shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink md:size-6 pointer-coarse:size-11"
        >
          <ChevronRight size={13} className={cx('transition-transform', open && 'rotate-90')} />
        </TooltipButton>}

        {editing ? (
          <RenameInput
            value={project.name}
            onCommit={commitRename}
            onCancel={() => setEditing(false)}
            className="h-7 min-w-0 flex-1 rounded border border-accent bg-sunken px-1.5 text-sm text-ink outline-none"
          />
        ) : (
          <NavLink
            to={projectViewPath(project.id, view)}
            onClick={onNavigate}
            // Double-click rename like file explorers. The first click still navigates, an
            // acceptable consequence of a link when renaming its project.
            onDoubleClick={(event) => {
              event.preventDefault()
              if (project.isOwner) setEditing(true)
            }}
            className="flex h-full min-w-0 flex-1 items-center gap-2 px-1.5 text-sm font-semibold"
            title={project.name}
          >
            <ProjectAvatar project={project} />
            <span className="truncate">{project.name}</span>
            {/* Only when collapsed: expanded rows already display these signals, making the dot redundant. */}
            {collapsed && hasUnread ? (
              <span
                title={t('shell.project.unread')}
                className="size-1.5 shrink-0 rounded-full bg-ink"
              />
            ) : null}
            {/* A project shell is running: reminder for development servers left behind closed sessions. */}
            {project.activeTerminals > 0 ? (
              <SquareTerminal
                size={12}
                className="shrink-0 text-positive"
                aria-label={t('shell.project.terminals')}
              />
            ) : null}
            {/* Mark only shared projects: private is normal and locks on nearly every row add no information. */}
            {project.visibility === 'shared' ? (
              <Users
                size={12}
                className="shrink-0 text-ink-faint"
                aria-label={t('shell.project.shared')}
              />
            ) : null}
          </NavLink>
        )}

        {project.isOwner ? (
          <Menu
            trigger={
              <IconButton
                label={t('shell.project.actions', { name: project.name })}
                size="sm"
                className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
              >
                <MoreHorizontal size={15} />
              </IconButton>
            }
          >
            <ProjectMenuItems variant="dropdown" project={project} onRename={() => setEditing(true)} onNavigate={onNavigate} />
          </Menu>
        ) : null}
      </div>
        }
      >
        <ProjectMenuItems variant="context" project={project} onRename={() => setEditing(true)} onNavigate={onNavigate} />
      </ContextMenu>
      </>}
      {open && <div className={cx('sidebar-project-content', !focused && 'sidebar-project-nested')}>
          <ul className="sidebar-project-links">
            <li><NavLink to={`/p/${project.id}/board`} onClick={onNavigate} className={({ isActive }) => cx('sidebar-project-link', isActive && 'sidebar-current')}><SquareKanban size={14} /><span className="flex-1">{t('shell.project.board')}</span><BoardCounts counts={project.cardCounts} /></NavLink></li>
            <WorktreesLine projectId={project.id} onNavigate={onNavigate} />
            {focused && <li><NavLink to={`/p/${project.id}/schedules`} onClick={onNavigate} className={({ isActive }) => cx('sidebar-project-link', isActive && 'sidebar-current')}><CalendarClock size={14} /><span className="flex-1">{t('schedule.sidebar.heading')}</span><span className="text-[0.625rem] text-ink-faint">{schedules.length}</span></NavLink></li>}
          </ul>
        {focused && <>
          <div className="sidebar-sessions-heading"><span>{t('shell.project.sessions')}<span className="ml-2 text-[0.625rem] font-normal tabular-nums text-ink-faint">{active.length}</span></span>
            <IconButton label={t('shell.sessions.filter')} size="sm" aria-expanded={filterOpen} onClick={() => { setFilterOpen(value => !value); setFilter(''); if (!filterOpen) requestAnimationFrame(() => filterInput.current?.focus()) }}><Search size={14} /></IconButton>
            <Tooltip label={t('shell.project.newSession')}><NavLink to={`/p/${project.id}/c/new`} onClick={onNavigate} aria-label={t('shell.project.newSession')} className="sidebar-add-session"><Plus size={16} /></NavLink></Tooltip>
          </div>
          {filterOpen && <div className="sidebar-session-filter"><Search size={14} /><input ref={filterInput} type="search" value={filter} onChange={event => setFilter(event.target.value)} aria-label={t('shell.sessions.search')} placeholder={t('shell.sessions.search')} /><IconButton label={t('shell.sessions.clear')} size="sm" onClick={() => { setFilter(''); filterInput.current?.focus() }}><X size={13} /></IconButton></div>}
        </>}
        <div className="sidebar-session-scroll" data-sidebar-session-scroll={project.id}>
          <ul className="flex flex-col gap-px">
            {!focused && <li><NavLink to={`/p/${project.id}/c/new`} onClick={onNavigate} className="sidebar-new-session"><Plus size={14} />{t('shell.project.newSession')}</NavLink></li>}
            {active.length > 0 ? <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis, restrictToParentElement]} onDragEnd={onDragEnd} onDragCancel={swallowNextClick}>
              <SortableContext items={visibleActive.map(entry => entry.id)} strategy={verticalListSortingStrategy}>
                {visibleActive.map(conversation => <ConversationRow key={conversation.id} conversation={conversation} toggleFavorite={toggleFavorite} draggable={!query} onNavigate={onNavigate} />)}
              </SortableContext>
            </DndContext> : <li className="px-3 py-3 text-xs text-ink-faint">{t('shell.conversations.empty')}</li>}
            {query && !visibleActive.length && <li role="status" className="px-3 py-3 text-xs text-ink-faint">{t('shell.sessions.noResults')}</li>}
            {focused && !query && (active.length > visibleActive.length || showAll) && <li><button type="button" onClick={() => setShowAll(value => !value)} className="min-h-11 w-full rounded px-3 text-left text-xs text-ink-faint hover:bg-surface-high">{t(showAll ? 'shell.switcher.less' : 'shell.switcher.more', { count: active.length })}</button></li>}
            {!focused && <SidebarSchedules projectId={project.id} tasks={schedules} conversations={scheduled} focused={false} onNavigate={onNavigate} renderRun={conversation => <ConversationRow key={conversation.id} conversation={conversation} toggleFavorite={toggleFavorite} draggable={false} onNavigate={onNavigate} />} />}
          </ul>
        </div>
        {archived.length > 0 && <div className="sidebar-archives">
          <button type="button" onClick={() => setArchiveOpen(value => !value)} aria-expanded={archiveOpen} aria-controls={`sidebar-archives-${project.id}`}><Archive size={14} /><span>{t('shell.conversations.archived', { count: String(archived.length) })}</span><ChevronRight size={12} className={cx('ml-auto', archiveOpen && 'rotate-90')} /></button>
          {archiveOpen && <ul id={`sidebar-archives-${project.id}`}>{archived.map(conversation => <ConversationRow key={conversation.id} conversation={conversation} toggleFavorite={toggleFavorite} draggable={false} onNavigate={onNavigate} />)}</ul>}
        </div>}
      </div>}
    </li>
  )
}

/**
 * Board summary beside the project heading uses words rather than color dots requiring a legend.
 * Keep two counts: open work (excluding terminal columns also collapsed on boards), and amber
 * review-needed work, the only queue requiring attention.
 */
function BoardCounts({ counts }: { counts: ProjectDto['cardCounts'] }) {
  const t = useTranslate()
  const review = counts.review ?? 0
  const open = (counts.todo ?? 0) + (counts.in_progress ?? 0) + review
  if (open === 0) return null
  return (
    <span className="shrink-0 font-medium tracking-normal normal-case tabular-nums">
      {t(open > 1 ? 'shell.project.boardOpen.many' : 'shell.project.boardOpen.one', { count: String(open) })}
      {review > 0 ? (
        <>
          {' · '}
          <span className="text-caution">{t('shell.project.boardReview', { count: String(review) })}</span>
        </>
      ) : null}
    </span>
  )
}

/**
 * Worktree summary beside projects in the board's format: remaining work (uncommitted, unmerged,
 * missing) and amber cleanup-only trees. Omit when no extra trees exist because the row matters
 * only through its count.
 */
function WorktreesLine({ projectId, onNavigate }: { projectId: string; onNavigate: () => void }) {
  const t = useTranslate()
  const { data } = useWorktreeStatuses(projectId)
  if (!data || data.worktrees.length === 0) return null
  const { pending, cleanable } = worktreeCounts(data)
  return (
    <li>
      <NavLink
        to={`/p/${projectId}#worktrees`}
        onClick={onNavigate}
        className="sidebar-project-link"
      >
        <FolderGit2 size={14} className="shrink-0" />
        <span className="flex-1">{t('shell.project.worktrees')}</span>
        <span className="shrink-0 font-medium tracking-normal normal-case tabular-nums">
          {pending > 0
            ? t(pending > 1 ? 'shell.project.worktreesPending.many' : 'shell.project.worktreesPending.one', { count: String(pending) })
            : null}
          {pending > 0 && cleanable > 0 ? ' · ' : null}
          {cleanable > 0 ? (
            <span className="text-caution">{t('shell.project.worktreesCleanable', { count: String(cleanable) })}</span>
          ) : null}
        </span>
      </NavLink>
    </li>
  )
}

function PersonalDiscussions({ conversations, toggleFavorite, onNavigate }: { conversations: ConversationDto[]; toggleFavorite: FavoriteMutation; onNavigate: () => void }) {
  const t = useTranslate()
  const navigate = useNavigate()
  const route = useMatch('/discussions/*')
  const [expanded, setExpanded] = useState(false)
  const [archives, setArchives] = useState(false)
  const personal = conversations.filter(entry => entry.projectId === null)
  const shown = personal.filter(entry => archives || entry.archivedAt === null)
  const open = Boolean(route) || expanded
  const recent = personal.find(entry => entry.archivedAt === null)
  return <section className="sidebar-personal" aria-label={t('discussions.title')}>
    <div className="flex min-h-11 items-center gap-1 px-3">
      <button type="button" className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left text-xs text-ink-soft hover:text-ink" aria-expanded={open} onClick={() => {
        if (!open) { setExpanded(true); navigate(recent ? conversationPath(recent) : '/discussions/new'); onNavigate() }
        else if (!route) setExpanded(false)
        else { navigate(recent ? conversationPath(recent) : '/discussions/new'); onNavigate() }
      }}><MessageSquare size={14} /><span>{t('discussions.title')}</span></button>
      <IconButton size="sm" label={t('discussions.new')} onClick={() => { navigate('/discussions/new'); onNavigate() }}><Plus size={15} /></IconButton>
      <Menu trigger={<IconButton size="sm" label={t('discussions.options')}><MoreHorizontal size={15} /></IconButton>}>
        <MenuItem icon={<Brain size={14} />} onSelect={() => { navigate('/discussions/memory'); onNavigate() }}>{t('discussions.memory')}</MenuItem>
        <MenuItem icon={<FolderOpen size={14} />} onSelect={() => { navigate('/discussions/files'); onNavigate() }}>{t('discussions.files')}</MenuItem>
        <MenuItem icon={<Archive size={14} />} onSelect={() => { setArchives(value => !value); setExpanded(true) }}>{t(archives ? 'discussions.hideArchives' : 'discussions.showArchives')}</MenuItem>
      </Menu>
    </div>
    {open ? <ul className="max-h-64 overflow-y-auto px-2 pb-1">
      {shown.map(conversation => <ConversationRow key={conversation.id} conversation={conversation} toggleFavorite={toggleFavorite} draggable={false} onNavigate={onNavigate} />)}
      {!shown.length ? <li className="px-3 py-2 text-xs text-ink-faint">{t('discussions.empty')}</li> : null}
    </ul> : null}
  </section>
}

function ConversationRow({
  conversation,
  toggleFavorite,
  onNavigate,
  draggable = true,
}: {
  conversation: ConversationDto
  toggleFavorite: FavoriteMutation
  onNavigate: () => void
  /**
   * False in Favorites, outside drag contexts: order follows the list and a draggable row would
   * have no drop container.
   */
  draggable?: boolean
}) {
  const t = useTranslate()
  const rename = useRenameConversation()
  const isArchived = conversation.archivedAt !== null
  const projectMatch = useMatch('/p/:projectId/c/:conversationId')
  const personalMatch = useMatch('/discussions/:conversationId')
  const openMatch = projectMatch ?? personalMatch
  const contextMenu = useContextMenuEnabled()
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  // Socket status takes precedence over the load-time list snapshot.
  const status = useLiveStatus(conversation.id) ?? conversation.status
  const background = useLiveBackground(conversation.id)
  const loops = useLiveLoops(conversation.id)
  const pushedSeq = useLiveSeq(conversation.id)
  // Same precedence as status: pushed values override the load-time list. Cold threads have no
  // pushes yet, so list readings remain correct.
  const metrics = useLiveMetrics(conversation.id) ?? conversation.metrics
  const signals = useMemo(
    () => buildSidebarSignals({ status, background, loops }),
    [status, background, loops],
  )
  const present = presentSignal(signals)
  const loop = signals.find((signal) => signal.kind === 'loop') ?? null
  const sortable = draggable && !isArchived

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: conversation.id,
    // Renaming adds an input, so disable dragging to permit text selection. Archived and favorite
    // rows are outside drag contexts and register nothing.
    disabled: !sortable || editing,
  })

  const commit = (draft: string) => {
    setEditing(false)
    const value = draft.trim()
    if (value && value !== conversation.title) {
      rename.mutate({ id: conversation.id, title: value })
    }
  }

  const style = { transform: CSS.Transform.toString(transform), transition }

  if (editing) {
    return (
      <li ref={setNodeRef} style={style}>
        <RenameInput
          value={conversation.title}
          onCommit={commit}
          onCancel={() => setEditing(false)}
          className="h-9 w-full rounded-md border border-accent bg-sunken px-2 text-sm text-ink outline-none"
        />
      </li>
    )
  }

  const isActive = openMatch?.params.conversationId === conversation.id
  /*
   * Convey unread through ink and weight rather than a third dot: rows hold at most two, and
   * another would compete with current-state signals. New content simply promotes muted text to
   * full ink. Exclude the open thread immediately without awaiting the server because its read
   * cursor is sent later.
   */
  const unread = !isActive && isUnread(conversation, pushedSeq)

  return (
    <ContextMenu disabled={!contextMenu} onOpenChange={setContextOpen} trigger={
      <li ref={setNodeRef} style={style} {...(sortable ? attributes : {})} {...(sortable ? listeners : {})}
        data-sidebar-session={conversation.id}
        className={cx('group/row sidebar-session', isDragging && 'relative z-10 bg-surface-high opacity-90', isActive && 'sidebar-current', unread && 'sidebar-unread')}>
        <SessionPreview conversation={conversation} metrics={metrics} signals={signals} disabled={menuOpen || contextOpen} trigger={
          <NavLink to={conversationPath(conversation)} onClick={onNavigate}
            onDoubleClick={event => { event.preventDefault(); if (conversation.isOwner) setEditing(true) }}
            className="sidebar-session-link">
            <AgentIcon agent={conversation.agent} size={16} />
            <span className="sidebar-session-title">{conversation.title}</span>
            {conversation.favorite && <Star size={10} aria-label={t('shell.favorites.heading')} className="shrink-0 text-ink-faint" />}
            <span className="sidebar-session-signals">{present && <SignalDot signal={present} />}{loop && <SignalDot signal={loop} />}</span>
          </NavLink>}>
          <span className="sidebar-session-actions">
            <time className="sidebar-session-age" dateTime={new Date(conversation.updatedAt).toISOString()} title={relativeDate(conversation.updatedAt)}>{compactRelativeDate(conversation.updatedAt)}</time>
            <Menu onOpenChange={setMenuOpen} trigger={<button type="button" aria-label={t('shell.conversation.actions')} className="sidebar-session-menu" onPointerDown={event => event.stopPropagation()}><MoreHorizontal size={15} /></button>}>
              <ConversationMenuItems variant="dropdown" conversation={conversation} toggleFavorite={toggleFavorite} onRename={() => setEditing(true)} />
            </Menu>
          </span>
        </SessionPreview>
      </li>}>
      <ConversationMenuItems variant="context" conversation={conversation} toggleFavorite={toggleFavorite} onRename={() => setEditing(true)} />
    </ContextMenu>
  )
}

/**
 * Conversation actions shared by ellipsis dropdown and row context menu: one list, two Radix
 * primitives with separate entries, like explorer actions.
 */
function ConversationMenuItems({
  variant,
  conversation,
  toggleFavorite,
  onRename,
}: {
  variant: 'context' | 'dropdown'
  conversation: ConversationDto
  toggleFavorite: FavoriteMutation
  onRename: () => void
}) {
  const t = useTranslate()
  const { copy, state: copyState } = useCopy()
  const remove = useDeleteConversation()
  const setArchived = useArchiveConversation()
  const isArchived = conversation.archivedAt !== null
  const navigate = useNavigate()
  const projectMatch = useMatch('/p/:projectId/c/:conversationId')
  const personalMatch = useMatch('/discussions/:conversationId')
  const openMatch = projectMatch ?? personalMatch
  const projectView = useProjectView(conversation.projectId ?? '')
  const Item = variant === 'context' ? ContextMenuItem : MenuItem
  const Separator = variant === 'context' ? ContextMenuSeparator : MenuSeparator

  return (
    <>
      <Item icon={<Star size={14} />} disabled={toggleFavorite.isPending} onSelect={() => toggleFavorite.mutate({ id: conversation.id, favorite: !conversation.favorite })}>
        {conversation.favorite ? t('shell.conversation.unfavorite') : t('shell.conversation.favorite')}
      </Item>
      <Item icon={<Link2 size={14} />} onSelect={event => { event.preventDefault(); copy(sessionReference(conversation.id)) }}>
        {t(copyState === 'copied' ? 'sessionRef.copied' : copyState === 'failed' ? 'sessionRef.copyFailed' : 'sessionRef.copy')}
      </Item>
      {conversation.isOwner ? (
        <>
          <Separator />
          <Item icon={<Pencil size={14} />} onSelect={onRename}>
            {t('shell.rename')}
          </Item>
          <Item
            icon={isArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            onSelect={() => setArchived.mutate({ id: conversation.id, archived: !isArchived })}
          >
            {isArchived ? t('shell.conversation.unarchive') : t('shell.conversation.archive')}
          </Item>
          <Separator />
          <Item
            icon={<Trash2 size={14} />}
            tone="critical"
            onSelect={() => {
              if (!confirm(t(conversation.projectId ? 'shell.conversation.deleteConfirm' : 'discussions.deleteConfirm', { title: conversation.title })))
                return
              const wasOpen = openMatch?.params.conversationId === conversation.id
              remove.mutate(conversation.id, {
                // Leave the view only if it is the deleted conversation, falling back to the
                // project's usual landing view rather than choosing a new home preference.
                onSuccess: () => {
                  if (wasOpen) navigate(conversation.projectId ? projectViewPath(conversation.projectId, projectView) : '/discussions/new')
                },
              })
            }}
          >
            {t('shell.delete')}
          </Item>
        </>
      ) : null}
    </>
  )
}

/** Project actions shared by ellipsis button and heading context menu. */
function ProjectMenuItems({
  variant,
  project,
  onRename,
  onNavigate,
}: {
  variant: 'context' | 'dropdown'
  project: ProjectDto
  onRename: () => void
  onNavigate: () => void
}) {
  const t = useTranslate()
  const navigate = useNavigate()
  const updateProject = useUpdateProject()
  const Item = variant === 'context' ? ContextMenuItem : MenuItem
  const Separator = variant === 'context' ? ContextMenuSeparator : MenuSeparator
  const Swatch = variant === 'context' ? ContextMenuSwatch : MenuSwatch
  const go = (path: string) => {
    onNavigate()
    navigate(path)
  }

  return (
    <>
      <Item icon={<Pencil size={14} />} onSelect={onRename}>
        {t('shell.rename')}
      </Item>
      <Item icon={<SquareKanban size={14} />} onSelect={() => go(`/p/${project.id}/board`)}>
        {t('shell.project.board')}
      </Item>
      <Item icon={<CalendarClock size={14} />} onSelect={() => go(`/p/${project.id}/schedules`)}>
        {t('schedule.title')}
      </Item>
      <Item icon={<SlidersHorizontal size={14} />} onSelect={() => go(`/p/${project.id}`)}>
        {t('shell.project.settings')}
      </Item>
      <Separator />
      {/* Labels and rows are plain blocks shared by both primitives. */}
      <MenuLabel>
        <span className="flex items-center gap-1.5">
          <Palette size={11} /> {t('shell.color')}
        </span>
      </MenuLabel>
      <MenuSwatchRow>
        {PROJECT_COLORS.map((entry) => (
          <Swatch
            key={entry.value ?? 'default'}
            color={entry.value}
            label={t(entry.label)}
            selected={project.color === entry.value}
            onSelect={() => updateProject.mutate({ id: project.id, color: entry.value })}
          />
        ))}
      </MenuSwatchRow>
    </>
  )
}

function SidebarRow({
  to,
  end = true,
  onClick,
  children,
}: {
  to: string
  end?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      className={({ isActive }) =>
        cx(
          'flex h-10 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors',
          isActive
            ? 'bg-accent-wash font-medium text-ink'
            : 'text-ink-soft hover:bg-surface-high hover:text-ink',
        )
      }
    >
      {children}
    </NavLink>
  )
}
