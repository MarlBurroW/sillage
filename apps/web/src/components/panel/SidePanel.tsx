import { TooltipButton } from '../ui/Tooltip'
import {
  Bot,
  FileCode,
  GitCompare,
  History,
  Maximize2,
  Expand,
  Minimize2,
  Search,
  Columns2,
  PanelLeft,
  PlugZap,
  RefreshCw,
  SquareTerminal,
  X,
  Zap,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentKind, McpServerStatus } from '@sillage/protocol'
import { useActions } from '../../lib/actions'
import type { BackgroundWork } from '../../lib/background'
import type { EditTurn, TurnCheckpoint } from '../../lib/chat-fold'
import { openTab } from '../../lib/editor-tabs'
import { useTranslate } from '../../lib/i18n'
import {
  restorePanelWidth,
  setDockedPanelWidth,
  setPanelExpanded,
  setPanelOpen,
  setPanelTab,
  setPanelTree,
  setPanelWidth,
  usePanelTab,
  usePanelTree,
  useSelectedSubAgent,
  type PanelTab,
} from '../../lib/panel'
import { projectScope } from '../../lib/workspace-scope'
import { resizeHandle } from '../../lib/resize-handle'
import { useMediaQuery } from '../../lib/viewport'
import { PanelFocus } from '../PanelFocus'
import type { SubAgent } from '../../lib/subagents'
import { useRefreshTree } from '../../lib/tree'
import { useProjects } from '../../lib/projects'
import { IconButton, cx } from '../ui'
import { ActionsPane } from './ActionsPane'
import { AgentsPane } from './AgentsPane'
import { FilesPane } from './FilesPane'
import { GitPane } from './GitPane'
import { HistoryPane } from './HistoryPane'
import { McpPane } from './McpPane'
import { TerminalsPane } from './TerminalsPane'
import { QuickOpen } from './QuickOpen'

/**
 * Right-side panel beside the thread when space permits, with expanded editor view. Overlay content
 * on phones and boards. No backdrop or outside-click closure: live terminals and ongoing editing
 * must not disappear after a misplaced click. Conversations use their cwd including worktrees,
 * where agents write. Project views (Board, draft) have no conversation: Files, Git, and Terminals
 * use project workspace; omit session-only History, Agents, and MCP tabs.
 */
export function SidePanel({
  projectId,
  conversationId,
  agent,
  editTurns = [],
  history,
  checkpoints = [],
  canRestore = false,
  turnRunning = false,
  subAgents = [],
  background = [],
  mcpServers = [],
  open,
  docked = false,
  canDock = false,
  workspaceName,
}: {
  projectId: string
  /** Absent in project views, leaving directory-oriented tabs only. */
  conversationId?: string
  /** Conversation CLI for actions supported by particular CLIs. */
  agent?: AgentKind
  editTurns?: EditTurn[]
  history?: { hasMore: boolean; loading: boolean; load: () => Promise<void> }
  /** Turn checkpoints for turn-filtered Git views. */
  checkpoints?: TurnCheckpoint[]
  /** True for the thread owner, the only user allowed to restore workspace state. */
  canRestore?: boolean
  turnRunning?: boolean
  subAgents?: SubAgent[]
  background?: BackgroundWork[]
  mcpServers?: McpServerStatus[]
  /** False during exit: still mounted but leaving. */
  open: boolean
  docked?: boolean
  canDock?: boolean
  workspaceName?: string
}) {
  // Tab state lives outside the panel because thread actions choose it when opening diff files or
  // banner subagents.
  const t = useTranslate()
  const { data: allActions } = useActions()
  const proposedActions = (allActions ?? []).filter(
    (action) => action.projectId === projectId && action.status === 'proposed',
  ).length
  const scope = conversationId ?? projectScope(projectId)
  const { data: projects } = useProjects()
  const projectName = projects?.find((project) => project.id === projectId)?.name
  const workspaceLabel = [projectName, workspaceName ?? t('terminal.dir.workspace')].filter(Boolean).join(' · ')
  const chosenTab = usePanelTab()
  // Tab selection survives view changes; project views fall back from session-only tabs to Files
  // rather than displaying nothing.
  const tab: PanelTab =
    conversationId || !['history', 'agents', 'mcp'].includes(chosenTab) ? chosenTab : 'files'
  const treeOpen = usePanelTree()
  const selectedSubAgent = useSelectedSubAgent()
  /**
   * First render deliberately starts offscreen, entering only next render: elements born in place
   * have no transition and would appear abruptly.
   */
  const [entered, setEntered] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const aside = useRef<HTMLElement>(null)
  const refresh = useRefreshTree(scope)
  const wasRunning = useRef(turnRunning)
  const wide = useMediaQuery('(min-width: 48rem)')
  const modal = !wide || fullscreen

  /** Opening a diff file creates its tab in view of the requester. */
  const openInFiles = (path: string) => {
    openTab(scope, path)
    setPanelTab('files')
    // Opening from palettes or diffs must reveal the file on phones.
    if ((aside.current?.clientWidth ?? 0) < 560) setPanelTree(false, false)
  }

  useEffect(restorePanelWidth, [])

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  /**
   * Refresh at turn completion when tree changes are settled, not continuously: files change on
   * every write during turns and repeated refresh would flash without adding useful information.
   */
  useEffect(() => {
    if (wasRunning.current && !turnRunning) refresh()
    wasRunning.current = turnRunning
  }, [turnRunning, refresh])

  /**
   * Panel hugs the window's right edge, so width is pointer distance from that edge without
   * retaining a gesture-start offset.
   */
  const handle = resizeHandle({
    widthAt: (clientX) => window.innerWidth - clientX,
    current: () => aside.current?.getBoundingClientRect().width ?? null,
    apply: docked ? setDockedPanelWidth : setPanelWidth,
  })

  return (
    <PanelFocus open={open} modal={modal} onClose={() => fullscreen ? setFullscreen(false) : setPanelOpen(false)} protectEditor>
    <aside
      ref={aside}
      inert={!open}
      aria-hidden={!open}
      aria-label={t('panel.aria')}
      role={modal ? 'dialog' : undefined}
      aria-modal={modal && open ? true : undefined}
      // Stable marker for thread-search shortcuts to detect origins here: aria-label changes with language.
      data-panel="workspace"
      data-fullscreen={fullscreen || undefined}
      onKeyDownCapture={(event) => {
        if (!open || quickOpen || tab !== 'files' || event.defaultPrevented || event.altKey || event.shiftKey) return
        if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'p') return
        if (!aside.current?.contains(event.target as Node)) return
        event.preventDefault()
        event.stopPropagation()
        setQuickOpen(true)
      }}
      className={cx(
        // Do not hide overflow here or the left-edge resize handle is clipped; inner scrolling
        // bounds content. Shadow conveys elevation, distinguishing the overlay from an extra column
        // apparently clipping the thread.
        'surface flex flex-col border-l border-line shadow-pop',
        // Fullscreen on touch, adjustable width beyond. Absolute positioning references the shell
        // layer and follows visual viewport. Clamp width in CSS as well as persistence so later
        // window resizing cannot leave an oversized panel.
        fullscreen ? 'app-layer z-40 pt-safe' : docked
          ? 'relative z-20 h-full w-[clamp(20rem,var(--panel-docked-width,48%),calc(100%-26rem))] shrink-0'
          : 'absolute inset-0 z-20 md:left-auto md:w-[min(var(--panel-width,45rem),calc(100vw-10rem))]',
        // Transition translate rather than transform: Tailwind v4 uses the distinct CSS translate property.
        'transition-[translate] duration-200 ease-out',
        entered && open ? 'translate-x-0' : 'translate-x-full',
      )}
    >
      <div className="flex min-h-0 flex-1">
        {/*
         * The rail keeps all sections accessible without shrinking targets in narrow panels and
         * scrolls on short screens.
         */}
        <nav aria-label={t('panel.aria')} className="flex w-12 shrink-0 flex-col items-center overflow-y-auto border-r border-line bg-sunken py-1 pb-safe">
          <Tab
            icon={<FileCode size={20} />}
            label={t('panel.tab.files')}
            active={tab === 'files'}
            onSelect={() => setPanelTab('files')}
          />
          <Tab
            icon={<GitCompare size={20} />}
            label={t('panel.tab.git')}
            active={tab === 'git'}
            onSelect={() => setPanelTab('git')}
          />
          {conversationId ? (
            <Tab
              icon={<History size={20} />}
              label={t('panel.tab.history')}
              active={tab === 'history'}
              onSelect={() => setPanelTab('history')}
            />
          ) : null}
          <Tab
            icon={<SquareTerminal size={20} />}
            label={t('panel.tab.terminals')}
            active={tab === 'terminals'}
            onSelect={() => setPanelTab('terminals')}
          />
          <Tab
            icon={<Zap size={20} />}
            label={t('panel.tab.actions')}
            // Count only actions awaiting review because they need the user.
            badge={proposedActions}
            active={tab === 'actions'}
            onSelect={() => setPanelTab('actions')}
          />
          {conversationId ? (
            <>
              <Tab
                icon={<Bot size={20} />}
                label={t('panel.tab.agents')}
                badge={
                  subAgents.filter((agent) => agent.status === 'running').length + background.length
                }
                active={tab === 'agents'}
                onSelect={() => setPanelTab('agents')}
              />
              <Tab
                icon={<PlugZap size={20} />}
                label={t('panel.tab.mcp')}
                // Count only failing servers: badging a healthy inventory would constantly demand attention without reason.
                badge={
                  mcpServers.filter((s) => s.state === 'failed' || s.state === 'needs-auth').length
                }
                active={tab === 'mcp'}
                onSelect={() => setPanelTab('mcp')}
              />
            </>
          ) : null}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-h-[var(--header-height)] shrink-0 flex-wrap items-center gap-y-1 border-b border-line px-1.5 py-1">
        <div className="min-w-0 flex-1 pl-2">
          <h2 className="truncate text-sm font-medium text-ink">{t(`panel.tab.${tab}`)}</h2>
          {fullscreen ? <p title={workspaceLabel} className="hidden truncate text-xs text-ink-faint md:block">{workspaceLabel}</p> : null}
        </div>

        <div className="flex shrink-0 items-center gap-0.5 pl-1">
          {canDock && !fullscreen ? (
            <IconButton
              label={t(docked ? 'panel.expand' : 'panel.dock')}
              size="sm"
              onClick={() => setPanelExpanded(docked)}
            >
              {docked ? <Maximize2 size={16} /> : <Columns2 size={16} />}
            </IconButton>
          ) : null}
          {wide || fullscreen ? <IconButton size="sm" label={t(fullscreen ? 'panel.fullscreen.exit' : 'panel.fullscreen.enter')} onClick={() => setFullscreen((value) => !value)}>
            {fullscreen ? <Minimize2 size={16} /> : <Expand size={16} />}
          </IconButton> : null}
          {tab === 'files' ? (
            <>
              <IconButton size="sm" label={t('editor.quickOpen.title')} aria-keyshortcuts="Control+P Meta+P" onClick={() => setQuickOpen(true)}><Search size={16} /></IconButton>
              <IconButton
                label={treeOpen ? t('panel.tree.hide') : t('panel.tree.show')}
                size="sm"
                onClick={() => setPanelTree(!treeOpen)}
              >
                <PanelLeft size={16} className={cx(treeOpen && 'text-accent')} />
              </IconButton>
              <IconButton label={t('panel.tree.refresh')} size="sm" onClick={refresh}>
                <RefreshCw size={15} />
              </IconButton>
            </>
          ) : null}
          <IconButton data-panel-initial-focus label={t('panel.close')} size="sm" onClick={() => setPanelOpen(false)}>
            <X size={17} />
          </IconButton>
        </div>
      </header>

      {/*
       * Keep Files mounted behind other tabs to preserve tree expansion, scroll, and editor
       * contents without rereads.
       */}
      <div
        className={cx(
          'min-h-0 min-w-0 flex-1 overflow-hidden pb-safe',
          tab === 'files' ? 'flex' : 'hidden',
        )}
      >
        <FilesPane scope={scope} />
      </div>

      {history?.hasMore && ['history', 'agents', 'git'].includes(tab) ? (
        <button type="button" disabled={history.loading} onClick={() => void history.load()}
          className="shrink-0 border-b border-line p-2 text-xs text-ink-soft hover:text-ink">
          {t(history.loading ? 'journal.history.loading' : 'journal.history.earlier')}
        </button>
      ) : null}

      {/* Mount these two views only when visible: log data or on-show Git rereads lose nothing. */}
      {tab === 'git' ? (
        <GitPane
          scope={scope}
          conversationId={conversationId}
          checkpoints={checkpoints}
          canRestore={canRestore}
          turnRunning={turnRunning}
          onOpenFile={openInFiles}
        />
      ) : null}

      {tab === 'history' && conversationId ? (
        <HistoryPane
          conversationId={conversationId}
          turns={editTurns}
          onOpenFile={openInFiles}
        />
      ) : null}

      {/*
       * Mount terminals with the panel, not just active tabs: switching to diffs must not interrupt
       * compiling shells.
       */}
      <div
        className={cx(
          'min-h-0 min-w-0 flex-1 overflow-hidden',
          tab === 'terminals' ? 'flex' : 'hidden',
        )}
      >
        <div className="min-h-0 min-w-0 flex-1">
          <TerminalsPane
            projectId={projectId}
            conversationId={conversationId}
            visible={tab === 'terminals'}
          />
        </div>
      </div>

      {tab === 'actions' ? <ActionsPane projectId={projectId} conversationId={conversationId} /> : null}

      {/*
       * Mount agents only when visible: no live content is retained, all comes from logs, and
       * hidden timers need not tick.
       */}
      {tab === 'agents' && conversationId && agent ? (
        <AgentsPane
          conversationId={conversationId}
          agent={agent}
          agents={subAgents}
          background={background}
          selectedId={selectedSubAgent}
        />
      ) : null}

      {/* Like subagents, log-derived content loses nothing by mounting only when viewed. */}
      {tab === 'mcp' ? <McpPane servers={mcpServers} /> : null}

        </div>
      </div>

      {/* Left-edge resize handle on desktop only; fullscreen touch panels have nothing to adjust. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('panel.resize.aria')}
        tabIndex={0}
        onPointerDown={handle.onPointerDown}
        onKeyDown={handle.onKeyDown}
        className={cx(
          'absolute inset-y-0 -left-1 hidden w-2 cursor-col-resize',
          !fullscreen && 'md:block',
          'after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2',
          'after:transition-colors hover:after:bg-accent focus-visible:after:bg-accent',
          'outline-none',
        )}
      />
      <QuickOpen scope={scope} workspaceLabel={workspaceLabel} open={open && quickOpen} onOpenChange={setQuickOpen} onSelect={openInFiles} />
    </aside>
    </PanelFocus>
  )
}

function Tab({
  icon,
  label,
  active,
  badge = 0,
  onSelect,
}: {
  icon: ReactNode
  label: string
  active: boolean
  /** Tab count; zero displays nothing. */
  badge?: number
  onSelect: () => void
}) {
  const t = useTranslate()
  return (
    <TooltipButton
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      // Keep the button's accessible name when its visible label disappears: icons alone cannot
      // explain their destination.
      aria-label={badge > 0 ? t('panel.tab.badge', { label, count: badge }) : label}
      title={label}
      className={cx(
        'relative flex size-11 shrink-0 items-center justify-center border-l-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-accent',
        active ? 'border-accent bg-accent-wash text-accent' : 'border-transparent text-ink-faint hover:bg-surface-high hover:text-ink',
      )}
    >
      <span className="shrink-0">{icon}</span>
      {badge > 0 ? (
        <span className="absolute top-1 right-0.5 flex min-w-4 h-4 px-0.5 items-center justify-center rounded-full bg-accent text-[0.625rem] font-semibold text-accent-ink">
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </TooltipButton>
  )
}
