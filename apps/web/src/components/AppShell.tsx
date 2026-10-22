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
  ChevronRight,
  FolderPlus,
  ListTree,
  MessagesSquare,
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
import type { ConversationDto, ConversationMetrics, ProjectDto, ScheduledTaskDto } from '@sillage/protocol'
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
import { WorktreeTag } from './WorktreeTag'
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
  setSidebarDetailed,
  setSidebarHidden,
  setSidebarWidth,
  useSidebarDetailed,
  useSidebarHidden,
} from '../lib/sidebar'
import { formatBytes } from '../lib/attachments'
import { formatTokens } from '../lib/tokens'
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
  const boardRoute = useMatch('/p/:projectId/board')
  const servicesRoute = useMatch('/services')
  const schedulesRoute = useMatch('/p/:projectId/schedules')
  const automationRoute = useMatch('/p/:projectId/schedules/:taskId')
  const contextualHeader = Boolean(conversationRoute || boardRoute || servicesRoute || schedulesRoute || automationRoute)
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
  const updateNotice = useUpdateNotice()
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
  const detailed = useSidebarDetailed()
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
  const [favoritesOpen, setFavoritesOpen] = useState(true)

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
    <div className="flex h-full flex-col">
      <div className="flex h-[var(--header-height)] shrink-0 items-center gap-2 px-4">
        <Logo size={20} className="text-accent" />
        <span className="text-[0.9375rem] font-semibold tracking-tight">Sillage</span>
        {/*
         * Use wrappers instead of hidden on IconButton, whose inline-flex conflicts according to
         * generated CSS order rather than class order. Otherwise both buttons appeared on mobile.
         */}
        <span className="ml-auto md:hidden">
          <IconButton label={t('shell.nav.close')} onClick={onClose}>
            <X size={18} />
          </IconButton>
        </span>
        <span className="ml-auto hidden md:block">
          <IconButton label={t('shell.nav.collapse')} onClick={onCollapse}>
            <PanelLeftClose size={18} />
          </IconButton>
        </span>
      </div>

      <div className="shrink-0 px-2 pb-1">
        {/* Keyboard shortcuts do not exist on touch: this entry makes phone search reachable. */}
        <button
          type="button"
          onClick={onSearch}
          className={cx(
            'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm',
            'text-ink-soft transition-colors hover:bg-surface-high hover:text-ink',
          )}
        >
          <Search size={15} className="shrink-0" />
          <span className="flex-1">{t('shell.search')}</span>
          <kbd className="hidden shrink-0 rounded border border-line px-1 text-[0.625rem] text-ink-faint md:block">
            {SEARCH_HINT}
          </kbd>
        </button>
      </div>

      {toggleFavorite.isError ? <div className="shrink-0 px-2 pb-2">
        <Banner>
          <span className="block">{t('shell.favorites.error')}</span>
          <span className="mt-1 block text-xs">{toggleFavorite.error.message}</span>
          <span className="mt-1 flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => {
              if (toggleFavorite.variables) toggleFavorite.mutate(toggleFavorite.variables)
            }}>{t('editor.retry')}</Button>
            <IconButton size="sm" label={t('common.close')} onClick={() => toggleFavorite.reset()}><X size={14} /></IconButton>
          </span>
        </Banner>
      </div> : null}

      <div className="shrink-0 px-2">
        <ProjectSwitcher onNavigate={onNavigate} key={user?.id ?? ''} userId={user?.id ?? ''} projects={projects ?? []} selected={selectedProject}
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
      <nav ref={nav} className="relative min-h-0 flex flex-1 flex-col px-2">
        <PullToRefresh target={nav} refreshing={refreshing} onRefresh={refresh} />
        <SidebarDecisions onNavigate={onNavigate} />
        <SidebarActivity conversations={attended} projects={projects} onNavigate={onNavigate}>
        {/*
         * Bookmarks span projects above their lists, allowing access without remembering origins.
         * Conversations remain listed in their own projects too.
         */}
        {favorites.length > 0 ? (
          <div className="mb-1">
            <button
              type="button"
              onClick={() => setFavoritesOpen((current) => !current)}
              aria-expanded={favoritesOpen}
              className="flex w-full items-center gap-1 py-1 pr-1 pl-1.5 text-[0.6875rem] font-semibold tracking-wider text-ink-faint uppercase transition-colors hover:text-ink-soft"
            >
              <ChevronRight
                size={11}
                className={cx('shrink-0 transition-transform', favoritesOpen && 'rotate-90')}
              />
              <span className="flex-1 text-left">{t('shell.favorites.heading')}</span>
              <span className="tabular-nums">{favorites.length}</span>
            </button>
            {favoritesOpen ? (
              <ul className="flex flex-col gap-px">
                {favorites.map((conversation) => (
                  <ConversationRow
                    key={conversation.id}
                    conversation={conversation}
                    toggleFavorite={toggleFavorite}
                    draggable={false}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center justify-between py-1 pr-1 pl-2.5">
          <span className="text-[0.6875rem] font-semibold tracking-wider text-ink-faint uppercase">
            {t(allProjects ? 'shell.projects.heading' : 'shell.switcher.project')}
          </span>
          <span className="flex items-center">
            {/*
             * Touch also refreshes by pulling down. Retain the button for mouse users and those
             * unfamiliar with the gesture.
             */}
            <IconButton label={t('shell.refresh')} size="sm" onClick={refresh} aria-busy={refreshing}>
              <RefreshCw size={15} className={cx(refreshing && 'animate-spin')} />
            </IconButton>
            {/* One switch for the entire list enables comparison impossible with individual expansion. */}
            <IconButton
              label={detailed ? t('shell.conversations.detail.hide') : t('shell.conversations.detail.show')}
              size="sm"
              onClick={() => setSidebarDetailed(!detailed)}
              className={detailed ? 'text-accent' : undefined}
            >
              <ListTree size={15} />
            </IconButton>
            <Tooltip label={t('shell.projects.add')}><NavLink to="/projects/new" onClick={onNavigate} aria-label={t('shell.projects.add')}
              className="inline-flex size-11 items-center justify-center rounded-md text-ink-faint hover:bg-surface-high hover:text-ink md:size-7 pointer-coarse:size-11">
                <FolderPlus size={15} />
            </NavLink></Tooltip>
          </span>
        </div>

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
              <ul className="flex flex-col gap-2">
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
        </SidebarActivity>
      </nav>

      <div className="shrink-0 border-t border-line p-2 pb-safe">
        <SidebarRow to="/services" onClick={onNavigate}>
          <Server size={16} className="shrink-0" />
          <span>{t('services.title')}</span>
        </SidebarRow>
        <SidebarRow to="/settings" end={false} onClick={onNavigate}>
          <span className="relative shrink-0">
            <Settings size={16} />
            {updateNotice ? <UpdateDot /> : null}
          </span>
          <span className="truncate">{t('shell.settings.label')}</span>
          {updateNotice ? <span className="sr-only">{t('about.badge.updateAvailable')}</span> : null}
        </SidebarRow>
        {passwordAuth ? (
          <button
            type="button"
            onClick={() => logout.mutate()}
            className={cx(
              'flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm',
              'text-ink-faint transition-colors hover:bg-surface-high hover:text-ink',
            )}
          >
            <LogOut size={16} className="shrink-0" />
            {t('shell.logout')}
          </button>
        ) : null}
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
  const visibleActive = focused && !showAll
    ? active.filter((entry, index) => index < 10 || entry.id === openConversationId || entry.favorite)
    : active
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

    const ids = active.map((entry) => entry.id)
    const from = ids.indexOf(String(dragged.id))
    const to = ids.indexOf(String(over.id))
    if (from === -1 || to === -1) return

    reorder.mutate(arrayMove(ids, from, to))
  }

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx(isDragging && 'shadow-float z-10 rounded-md bg-surface-high opacity-90')}
    >
      {/* The whole row owns hover background, including action buttons that otherwise look outside it. */}
      {/*
       * Heading right-click opens the ellipsis menu like file explorers, avoiding precise targets.
       * Listen only on headings because conversation rows below have their own menus.
       */}
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

      {open ? (
        <ul className="mt-1 mb-2 ml-3 flex flex-col gap-px border-l border-line pl-1.5">
          {/*
           * Single-project navigation uses consistent small-caps Board, Sessions, Scheduled, and
           * trailing Archive sections. Board and Scheduled headings link to pages without inline
           * rows. All-project views omit these repeated headings for density, retaining Add and
           * sessions; Board stays in project menus.
           */}
          {focused ? (
            <>
              <li>
                <NavLink
                  to={`/p/${project.id}/board`}
                  onClick={onNavigate}
                  className={({ isActive }) => cx(
                    'flex min-h-11 items-center gap-1.5 rounded px-1 text-[0.6875rem] font-semibold tracking-wider uppercase transition-colors hover:text-ink-soft md:min-h-7 pointer-coarse:min-h-11',
                    isActive ? 'text-ink' : 'text-ink-faint',
                  )}
                >
                  <SquareKanban size={11} className="shrink-0" />
                  <span className="flex-1">{t('shell.project.board')}</span>
                  <BoardCounts counts={project.cardCounts} />
                </NavLink>
              </li>
              <WorktreesLine projectId={project.id} onNavigate={onNavigate} />
              <li className="mt-2 flex h-7 items-center gap-1.5 px-1 text-[0.6875rem] font-semibold tracking-wider text-ink-faint uppercase">
                <MessagesSquare size={11} className="shrink-0" />
                <span className="flex-1">{t('shell.project.sessions')}</span>
                <span className="tabular-nums">{active.length}</span>
              </li>
            </>
          ) : null}
          {/* Adding opens the list receiving the item, like new scheduled tasks. */}
          <li>
            <NavLink
              to={`/p/${project.id}/c/new`}
              onClick={onNavigate}
              className={({ isActive }) => cx(
                'flex min-h-11 items-center gap-2 rounded-md px-2 text-[0.8125rem] transition-colors hover:bg-surface-high hover:text-ink md:min-h-8 pointer-coarse:min-h-11',
                isActive ? 'bg-surface-high text-ink' : 'text-ink-faint',
              )}
            >
              <Plus size={13} className="shrink-0" />{t('shell.project.newSession')}
            </NavLink>
          </li>
          {active.length > 0 ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToParentElement]}
              onDragEnd={onDragEnd}
              // Escape cancellation also releases the mouse over the link: suppress its click too
              // or cancellation opens the conversation.
              onDragCancel={swallowNextClick}
            >
              <SortableContext
                items={visibleActive.map((entry) => entry.id)}
                strategy={verticalListSortingStrategy}
              >
                {visibleActive.map((conversation) => (
                  <ConversationRow
                    key={conversation.id}
                    conversation={conversation}
                    toggleFavorite={toggleFavorite}
                    onNavigate={onNavigate}
                  />
                ))}
              </SortableContext>
            </DndContext>
          ) : (
            <li className="px-2 py-1.5 text-xs text-ink-faint">{t('shell.conversations.empty')}</li>
          )}

          {focused && (active.length > visibleActive.length || showAll) && <li>
            <button type="button" onClick={() => setShowAll((value) => !value)} className="min-h-9 w-full rounded px-2 text-left text-xs text-ink-soft hover:bg-surface-high">
              {t(showAll ? 'shell.switcher.less' : 'shell.switcher.more', { count: active.length })}
            </button>
          </li>}

          <SidebarSchedules
            projectId={project.id}
            tasks={schedules}
            conversations={scheduled}
            focused={focused}
            onNavigate={onNavigate}
            renderRun={(conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                toggleFavorite={toggleFavorite}
                draggable={false}
                onNavigate={onNavigate}
              />
            )}
          />

          {/*
           * Collapsed at list end: archived work remains reachable without crowding current
           * content. Outside drag contexts because archives have no manual order.
           */}
          {archived.length > 0 ? (
            <li>
              <button
                type="button"
                onClick={() => setArchiveOpen((current) => !current)}
                aria-expanded={archiveOpen}
                className="flex h-7 w-full items-center gap-1 rounded px-1 text-xs text-ink-faint transition-colors hover:bg-surface-high hover:text-ink-soft"
              >
                <ChevronRight
                  size={11}
                  className={cx('shrink-0 transition-transform', archiveOpen && 'rotate-90')}
                />
                {t('shell.conversations.archived', { count: String(archived.length) })}
              </button>
              {archiveOpen ? (
                <ul className="flex flex-col gap-px">
                  {archived.map((conversation) => (
                    <ConversationRow
                      key={conversation.id}
                      conversation={conversation}
                      toggleFavorite={toggleFavorite}
                      onNavigate={onNavigate}
                    />
                  ))}
                </ul>
              ) : null}
            </li>
          ) : null}
        </ul>
      ) : null}
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
        className="flex min-h-11 items-center gap-1.5 rounded px-1 text-[0.6875rem] font-semibold tracking-wider text-ink-faint uppercase transition-colors hover:text-ink-soft md:min-h-7 pointer-coarse:min-h-11"
      >
        <FolderGit2 size={11} className="shrink-0" />
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
  const openMatch = useMatch('/p/:projectId/c/:conversationId')
  const contextMenu = useContextMenuEnabled()
  const [editing, setEditing] = useState(false)
  // Socket status takes precedence over the load-time list snapshot.
  const status = useLiveStatus(conversation.id) ?? conversation.status
  const background = useLiveBackground(conversation.id)
  const loops = useLiveLoops(conversation.id)
  const pushedSeq = useLiveSeq(conversation.id)
  const detailed = useSidebarDetailed()
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
    // Right-clicking the row opens the ellipsis menu without requiring a precise button target.
    <ContextMenu
      disabled={!contextMenu}
      trigger={
    <li
      ref={setNodeRef}
      style={style}
      // Nondraggable rows stay navigable: disabled hook attributes would set aria-disabled on all
      // links and buttons, including favorites.
      {...(sortable ? attributes : {})}
      {...(sortable ? listeners : {})}
      className={cx(
        'group/row flex rounded-md pr-1 transition-colors',
        'min-h-11 items-center',
        isDragging ? 'shadow-float z-10 bg-surface-high opacity-90' : '',
        isActive ? 'bg-accent-wash' : 'hover:bg-surface-high hover:text-ink',
        /*
         * Promote the title one ink level when showing muted usage below; otherwise both looked
         * equal and the row lacked a heading. Raise the title instead of dimming usage because
         * muted ink is the minimum. Unread retains full ink and bold, preserving its difference
         * from read state.
         */
        isActive || unread ? 'text-ink' : detailed ? 'text-ink-soft' : 'text-ink-faint',
      )}
    >
      <NavLink
        to={`/p/${conversation.projectId}/c/${conversation.id}`}
        title={conversation.title}
        onClick={onNavigate}
        onDoubleClick={(event) => {
          event.preventDefault()
          if (conversation.isOwner) setEditing(true)
        }}
        className={cx(
          'flex min-w-0 flex-1 flex-col justify-center px-2 text-[0.8125rem]',
          'py-2',
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-ink-faint">
            <AgentIcon agent={conversation.agent} size={13} />
          </span>
          <span className={cx('line-clamp-2 break-words', unread && 'font-medium')}>{conversation.title}</span>
          {/*
           * At most two dots: current state and future loops. The first shows the most severe
           * present signal; loops remain beside it even during turns. Immutable origin markers
           * precede them without competing, disappearing on hover to reveal actions.
           */}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {conversation.origin ? (
              <span
                title={t('shell.conversation.origin', { label: conversation.origin.label })}
                className="rounded-full bg-accent-wash px-1 py-px text-[0.5625rem] font-semibold uppercase tracking-wide text-accent"
              >
                {t('shell.conversation.api')}
              </span>
            ) : null}
            {present ? <SignalDot signal={present} /> : null}
            {loop ? <SignalDot signal={loop} /> : null}
          </span>
        </span>
        {/* Outside the main tree show branch and tree state. Otherwise omit so worktree sessions stand out. */}
        <WorktreeTag conversation={conversation} />
        {detailed ? <ConversationMetricsLine metrics={metrics} /> : null}
      </NavLink>

      {/*
       * Keep existing bookmarks visible; adding moves into the menu to return an otherwise
       * invisible button's space to titles. Available on shared threads.
       */}
      {conversation.favorite ? (
      <IconButton
        label={t('shell.conversation.unfavorite')}
        disabled={toggleFavorite.isPending}
        size="sm"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() =>
          toggleFavorite.mutate({ id: conversation.id, favorite: !conversation.favorite })
        }
        className="self-center text-accent hover:text-accent"
      >
        <Star size={14} className={conversation.favorite ? 'fill-current' : undefined} />
      </IconButton>
      ) : null}

        <Menu
          trigger={
            <IconButton
              label={t('shell.conversation.actions')}
              size="sm"
              className="opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
            >
              <MoreHorizontal size={15} />
            </IconButton>
          }
        >
          <ConversationMenuItems variant="dropdown" conversation={conversation} toggleFavorite={toggleFavorite} onRename={() => setEditing(true)} />
        </Menu>
    </li>
      }
    >
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
  const remove = useDeleteConversation()
  const setArchived = useArchiveConversation()
  const isArchived = conversation.archivedAt !== null
  const navigate = useNavigate()
  const openMatch = useMatch('/p/:projectId/c/:conversationId')
  const projectView = useProjectView(conversation.projectId)
  const Item = variant === 'context' ? ContextMenuItem : MenuItem
  const Separator = variant === 'context' ? ContextMenuSeparator : MenuSeparator

  return (
    <>
      <Item icon={<Star size={14} />} disabled={toggleFavorite.isPending} onSelect={() => toggleFavorite.mutate({ id: conversation.id, favorite: !conversation.favorite })}>
        {conversation.favorite ? t('shell.conversation.unfavorite') : t('shell.conversation.favorite')}
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
              if (!confirm(t('shell.conversation.deleteConfirm', { title: conversation.title })))
                return
              const wasOpen = openMatch?.params.conversationId === conversation.id
              remove.mutate(conversation.id, {
                // Leave the view only if it is the deleted conversation, falling back to the
                // project's usual landing view rather than choosing a new home preference.
                onSuccess: () => {
                  if (wasOpen) navigate(projectViewPath(conversation.projectId, projectView))
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

/**
 * Usage readings beneath the title without border or background: continuation of the row rather
 * than an embedded panel. Keep one line, clipping rightward instead of wrapping, ordered from most
 * useful to incidental.
 */
function ConversationMetricsLine({ metrics }: { metrics: ConversationMetrics }) {
  const t = useTranslate()
  const { context } = metrics

  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-2 overflow-hidden pl-[21px] text-[0.6875rem] whitespace-nowrap text-ink-faint tabular-nums">
      <span title={t('shell.conversation.turnsTitle')}>
        {t('shell.conversation.turns', { count: metrics.turnCount })}
      </span>
      <span title={t('shell.conversation.sizeTitle')}>{formatBytes(metrics.journalBytes)}</span>
      {context && context.maxTokens > 0 ? (
        <span
          title={t('shell.conversation.contextTitle', {
            used: formatTokens(context.usedTokens),
            max: formatTokens(context.maxTokens),
          })}
        >
          {Math.round((context.usedTokens / context.maxTokens) * 100)} %
        </span>
      ) : null}
      {metrics.model ? (
        <span className="truncate" title={t('shell.conversation.modelTitle')}>
          {metrics.model}
        </span>
      ) : null}
    </span>
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
