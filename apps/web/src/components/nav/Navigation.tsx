import { claudeLoginExpiry, conversationPath } from '@sillage/protocol'
import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useLocation, useMatch, useNavigate } from 'react-router-dom'
import { useFollowedActivity, type ActivityCounts } from '../../lib/activity'
import { useCliUpdateNotice } from '../../lib/agents'
import { benchmarkState, useBenchmarks, useWaitingRuns } from '../../lib/benchmarks'
import { useClaudeHostLogin } from '../../lib/claude-accounts'
import { useAllConversations, useToggleFavorite } from '../../lib/conversations'
import { useRefreshLists, useStatusFeed } from '../../lib/conversation-status'
import { useTranslate } from '../../lib/i18n'
import { useCapability } from '../../lib/instance'
import { hasColumn, projectOfSpace, routeSpace, useNavSpace, type NavSpace } from '../../lib/nav-space'
import { projectViewOf, projectViewPath } from '../../lib/project-view'
import { useProjectVisits } from '../../lib/project-visits'
import { useProjects, useReorderProjects } from '../../lib/projects'
import { useLegacyPinMigration, useRailProjects } from '../../lib/rail-projects'
import { resizeHandle } from '../../lib/resize-handle'
import { useSchedules } from '../../lib/schedules'
import { useCurrentUser, useLogout } from '../../lib/session'
import { setNavColumnFolded, setSidebarWidth, useNavColumnFolded } from '../../lib/sidebar'
import { useUpdateNotice } from '../../lib/system'
import { PullToRefresh } from '../PullToRefresh'
import { Banner, Button, IconButton, cx } from '../ui'
import { ActivityColumn } from './ActivityColumn'
import { AddToRailPopover } from './AddToRailPopover'
import { BenchmarksColumn } from './BenchmarksColumn'
import { NavChromeContext } from './chrome'
import { DiscussionsColumn } from './DiscussionsColumn'
import { NavRail } from './NavRail'
import { ProjectColumn } from './ProjectColumn'
import { ProjectsDialog } from './ProjectsDialog'

/**
 * Navigation in two levels. The rail selects a space; the column lists what that space holds and
 * nothing else. Where a new feature goes follows from what it is:
 * - a place with its own list becomes a rail entry, and its column is its own;
 * - a view of a project becomes a row in the project column's first block;
 * - something that needs the user's attention becomes a kind of row in Activity;
 * - anything else belongs in settings or on the project page, reachable from the palette.
 */
export function Navigation({ wide, onNavigate, onClose, onSearch }: {
  /** Persistent beside the page; false for the phone drawer. */
  wide: boolean
  onNavigate: () => void
  onClose: () => void
  onSearch: () => void
}) {
  const t = useTranslate()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { data: user } = useCurrentUser()
  const { data: projects } = useProjects()
  const { data: conversations } = useAllConversations()
  const { data: schedules } = useSchedules()
  const { data: hostLogin } = useClaudeHostLogin()
  const hostExpiry = hostLogin && claudeLoginExpiry(hostLogin.loginExpiresAt) ? hostLogin : null
  const toggleFavorite = useToggleFavorite()
  const reorderProjects = useReorderProjects()
  const logout = useLogout()
  // Without a password, logout would leave an unusable login page.
  const passwordAuth = useCapability('passwordAuth')
  const appUpdateNotice = useUpdateNotice()
  const cliUpdateNotice = useCliUpdateNotice()
  const visits = useProjectVisits(user?.id ?? '')
  const folded = useNavColumnFolded()
  const { refreshing, refresh } = useRefreshLists()
  const column = useRef<HTMLDivElement>(null)
  const [managing, setManaging] = useState(false)
  useStatusFeed()
  useLegacyPinMigration(user?.id ?? '', projects)

  const openProjectThread = useMatch('/p/:projectId/c/:conversationId')?.params.conversationId
  const openDiscussion = useMatch('/discussions/:conversationId')?.params.conversationId
  const activity = useFollowedActivity(openProjectThread ?? openDiscussion)

  const fallback: NavSpace | null = projects?.length
    ? `project:${(projects.find((project) => project.id === visits[0]?.projectId) ?? projects[0]!).id}`
    : null
  const { space, columnSpace, setActivity } = useNavSpace(fallback)
  // Beside the page Activity is where its wall is; the drawer's sticky choice does not carry over.
  useEffect(() => { if (wide) setActivity(false) }, [wide, setActivity])
  // A phone drawer covers the page: its rail marks the list it shows, even over a tool page.
  const marked = wide ? space : columnSpace ?? 'discussions'
  const listed = wide ? (space && hasColumn(space) && !folded ? space : null) : marked
  const currentProject = projects?.find((project) => project.id === (marked ? projectOfSpace(marked) : null))

  const rail = useRailProjects(projects, visits, currentProject?.id ?? null)
  const recent = visits.map((visit) => visit.projectId)

  const pending = activity.decisions
  const countsOf = (projectId: string): ActivityCounts => {
    const counts = activity.ofProject(projectId)
    const waiting = pending.filter((decision) => decision.projectId === projectId).length
    return waiting ? { ...counts, awaiting: counts.awaiting + waiting } : counts
  }
  const { data: benchmarks } = useBenchmarks()
  const runningBenchmarks = benchmarks?.filter((benchmark) => benchmarkState(benchmark) === 'running') ?? []
  // A run that asked something stalls its measurement: it waits on the user like any session.
  const waitingRuns = useWaitingRuns(benchmarks)
  const total: ActivityCounts = { awaiting: activity.awaiting.length + pending.length + waitingRuns.length + (hostExpiry ? 1 : 0), running: activity.running.length + runningBenchmarks.length, unread: activity.unread.length }
  const unseen = (projects ?? []).filter((project) => !rail.isKept(project.id) && project.id !== rail.visiting?.id).map((project) => countsOf(project.id))
  // Running work elsewhere is not a reason to look: only waits and unread reach the entry that lists them.
  const hidden: ActivityCounts = { awaiting: unseen.reduce((sum, counts) => sum + counts.awaiting, 0), running: 0, unread: unseen.reduce((sum, counts) => sum + counts.unread, 0) }

  /** Where a space opens: the place last left there, so switching never loses one's position. */
  const pathOf = (target: NavSpace): string | null => {
    const projectId = projectOfSpace(target)
    if (projectId) {
      const visit = visits.find((entry) => entry.projectId === projectId)
      const conversationId = visit?.path.match(/\/c\/([\w-]+)$/)?.[1]
      const valid = !conversationId || conversationId === 'new' || conversations?.some((entry) => entry.id === conversationId && entry.projectId === projectId)
      return visit && valid ? visit.path : projectViewPath(projectId, projectViewOf(projectId))
    }
    if (target === 'discussions') {
      const recent = conversations?.find((entry) => entry.projectId === null && !entry.benchmarkId && entry.archivedAt === null)
      return recent ? conversationPath(recent) : '/discussions/new'
    }
    // Beside the page, Activity opens its wall. A drawer covers the page: it keeps what was open.
    if (target === 'activity') return wide ? '/wall' : null
    return `/${target}`
  }

  const select = (target: NavSpace) => {
    const projectId = projectOfSpace(target)
    const root = projectId ? `/p/${projectId}` : `/${target}`
    // Already inside: keep the place (a settings section, a wall view) rather than reset it.
    const inside = target === 'activity'
      ? (wide ? routeSpace(pathname) === 'activity' : space === 'activity')
      : pathname === root || pathname.startsWith(`${root}/`)
    // Pressing the current space again puts its column away, like an editor's activity bar.
    if (wide && inside && target === space && hasColumn(target)) { setNavColumnFolded(!folded); return }
    if (hasColumn(target)) setNavColumnFolded(false)
    setActivity(target === 'activity' && !wide)
    const path = inside ? null : pathOf(target)
    if (path) navigate(path)
    // Nothing to list: on a phone the drawer has no reason to stay over the page.
    if (!hasColumn(target)) onNavigate()
  }

  // Lists of projects open one without folding it: there, choosing the open project changes nothing.
  const openProject = (id: string) => { if (marked !== `project:${id}`) select(`project:${id}`) }
  const createProject = () => { navigate('/projects/new'); onNavigate() }

  const reorder = (draggedId: string, overId: string) => {
    // The rail shows a subset: place the mark next to the one it landed on in the full order.
    const shown = rail.kept.map((project) => project.id)
    const ids = (projects ?? []).map((project) => project.id).filter((id) => id !== draggedId)
    const anchor = ids.indexOf(overId)
    if (anchor === -1) return
    ids.splice(shown.indexOf(overId) > shown.indexOf(draggedId) ? anchor + 1 : anchor, 0, draggedId)
    reorderProjects.mutate(ids)
  }

  const handle = resizeHandle({
    widthAt: (clientX) => clientX - (column.current?.getBoundingClientRect().left ?? 0),
    current: () => column.current?.getBoundingClientRect().width ?? null,
    apply: setSidebarWidth,
  })

  const listedProject = listed ? projectOfSpace(listed) : null
  const project = listedProject ? projects?.find((entry) => entry.id === listedProject) : undefined

  return (
    <NavChromeContext.Provider value={{ wide, onNavigate, onClose, onFold: () => setNavColumnFolded(true) }}>
      <div className="sidebar-layout">
        <NavRail
          space={marked}
          total={total}
          benchmarks={{ awaiting: waitingRuns.length, running: runningBenchmarks.length, unread: 0 }}
          personal={activity.personal}
          rail={rail}
          countsOf={countsOf}
          hidden={hidden}
          updateNotice={appUpdateNotice || cliUpdateNotice ? t('about.badge.updateAvailable') : undefined}
          username={passwordAuth ? user?.username : undefined}
          onSpace={select}
          onProjectSettings={(id) => { setNavColumnFolded(false); navigate(`/p/${id}`) }}
          onReorder={reorder}
          onSearch={onSearch}
          onLogout={() => logout.mutate()}
          addProject={(trigger, zone) => (
            <AddToRailPopover trigger={trigger} zone={zone} projects={projects ?? []} rail={rail} recent={recent} countsOf={countsOf}
              onOpenProject={(chosen) => openProject(chosen.id)} onCreate={createProject} onManage={() => setManaging(true)} />
          )}
        />
        <ProjectsDialog open={managing} onOpenChange={setManaging} projects={projects ?? []} rail={rail} currentId={currentProject?.id} recent={recent} countsOf={countsOf}
          onOpenProject={(chosen) => openProject(chosen.id)} onCreate={createProject}
          onSettings={(chosen) => { navigate(`/p/${chosen.id}`); onNavigate() }} />
        {listed ? (
          <nav ref={column} className="nav-column" aria-label={t('shell.nav.label')} data-nav-column={listed}>
            <PullToRefresh target={column} refreshing={refreshing} onRefresh={refresh} />
            {toggleFavorite.isError && <div className="shrink-0 px-2 pt-2"><Banner>
              <span className="block">{t('shell.favorites.error')}</span><span className="mt-1 block text-xs">{toggleFavorite.error.message}</span>
              <span className="mt-1 flex items-center gap-1"><Button variant="ghost" size="sm" onClick={() => { if (toggleFavorite.variables) toggleFavorite.mutate(toggleFavorite.variables) }}>{t('editor.retry')}</Button><IconButton size="sm" label={t('common.close')} onClick={() => toggleFavorite.reset()}><X size={14} /></IconButton></span>
            </Banner></div>}
            {listed === 'activity' ? (
              <ActivityColumn runningBenchmarks={runningBenchmarks} waitingRuns={waitingRuns} awaiting={activity.awaiting} running={activity.running} unread={activity.unread} decisions={pending} hostExpiry={hostExpiry} favorites={activity.favorites} projects={projects ?? []} toggleFavorite={toggleFavorite} />
            ) : listed === 'discussions' ? (
              <DiscussionsColumn conversations={conversations ?? []} toggleFavorite={toggleFavorite} />
            ) : listed === 'benchmarks' ? (
              <BenchmarksColumn />
            ) : project ? (
              // Keyed: the filter and open archives belong to one project.
              <ProjectColumn key={project.id} project={project} rail={rail} toggleFavorite={toggleFavorite}
                conversations={(conversations ?? []).filter((entry) => entry.projectId === project.id)}
                schedules={(schedules ?? []).filter((task) => task.projectId === project.id)} />
            ) : (
              <p className="px-4 py-4 text-sm text-ink-faint">{t('shell.projects.empty')}</p>
            )}
          </nav>
        ) : null}
      </div>
      {/* On the navigation's outer edge, outside the column so it never counts as its content. Phones fill the width. */}
      {wide && listed ? (
        <div role="separator" aria-orientation="vertical" aria-label={t('shell.nav.resize.aria')} tabIndex={0}
          onPointerDown={handle.onPointerDown} onKeyDown={handle.onKeyDown}
          className={cx(
            'absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize outline-none',
            // Show the resize line only on hover: the border already suffices at rest.
            'after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2',
            'after:transition-colors hover:after:bg-accent focus-visible:after:bg-accent',
          )} />
      ) : null}
    </NavChromeContext.Provider>
  )
}
