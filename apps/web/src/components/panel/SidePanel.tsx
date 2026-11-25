import { TooltipButton } from '../ui/Tooltip'
import {
  Bot,
  FileCode,
  GitCompare,
  History,
  Layers2,
  Maximize,
  Minimize,
  Search,
  Columns2,
  FolderTree,
  Globe,
  MonitorPlay,
  PlugZap,
  SquareKanban,
  SquareTerminal,
  Zap,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentKind, McpServerStatus } from '@sillage/protocol'
import { useActions } from '../../lib/actions'
import type { BackgroundWork } from '../../lib/background'
import type { EditTurn, TaskState, TurnCheckpoint } from '../../lib/chat-fold'
import { useOpenPanelFile } from '../../lib/editor-focus'
import { useProjectFolders } from '../../lib/project-folders'
import { folderScope, useExplorerFolder } from '../../lib/explorer-folders'
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
import { PanelToggle } from './PanelToggle'
import type { SubAgent } from '../../lib/subagents'
import { useRefreshTree } from '../../lib/tree'
import { useProjects } from '../../lib/projects'
import { IconButton, cx } from '../ui'
import { ActionsPane } from './ActionsPane'
import { AgentsPane } from './AgentsPane'
import { FolderSwitcher } from './FolderSwitcher'
import { FilesPane } from './FilesPane'
import { GitPane } from './GitPane'
import { HistoryPane } from './HistoryPane'
import { CardPane } from './CardPane'
import { McpPane } from './McpPane'
import { BrowserPane } from '../browser/BrowserPane'
import { PreviewPane, projectTargets } from '../preview/PreviewPane'
import { usePreviews } from '../../lib/previews'
import { useBrowsers } from '../../lib/browsers'
import { useAppSettings } from '../../lib/app-settings'
import { resolveAgentTools } from '@sillage/protocol'
import { TerminalsPane } from './TerminalsPane'
import { QuickOpen } from './QuickOpen'

/** Shared empty default: a fresh map per render would re-render the Agents tab for nothing. */
const NO_WORKFLOWS: ReadonlyMap<string, TaskState> = new Map()

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
  workflows = NO_WORKFLOWS,
  mcpServers = [],
  open,
  docked = false,
  canDock = false,
  workspaceName,
  worktreePath,
  cardId = null,
  cardActions,
}: {
  projectId: string | null
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
  /** Workflow tasks by spawning call, finished ones included, whose agents the Agents tab opens. */
  workflows?: ReadonlyMap<string, TaskState>
  mcpServers?: McpServerStatus[]
  /** False during exit: still mounted but leaving. */
  open: boolean
  docked?: boolean
  canDock?: boolean
  workspaceName?: string
  worktreePath?: string
  /** Card the conversation handles, shown in its own tab. */
  cardId?: string | null
  /** Owner actions on the conversation's card link. */
  cardActions?: { change: () => void; detach: () => void; detaching: boolean }
}) {
  // Tab state lives outside the panel because thread actions choose it when opening diff files or
  // banner subagents.
  const t = useTranslate()
  const { data: allActions } = useActions()
  const proposedActions = (allActions ?? []).filter(
    (action) => action.projectId === projectId && action.status === 'proposed',
  ).length
  const scope = conversationId ?? projectScope(projectId ?? '')
  const { data: projects } = useProjects()
  const project = projects?.find((entry) => entry.id === projectId)
  const projectFolders = useProjectFolders(projectId)
  const folder = useExplorerFolder(scope, projectFolders.data)
  const filesScope = folder ? folderScope(folder) : scope
  const openPanelFile = useOpenPanelFile()
  const workspaceLabel = [project?.name, workspaceName ?? t('terminal.dir.workspace')].filter(Boolean).join(' · ')
  const chosenTab = usePanelTab()
  // Tab selection survives view changes; project views fall back from session-only tabs to Files
  // rather than displaying nothing.
  const tab: PanelTab =
    (!projectId && ['actions', 'terminals', 'preview'].includes(chosenTab)) || (chosenTab === 'card' && !(conversationId && cardId))
      ? 'files'
      : conversationId || !['history', 'agents', 'mcp', 'browser'].includes(chosenTab) ? chosenTab : 'files'
  const treeOpen = usePanelTree()
  const selectedSubAgent = useSelectedSubAgent()
  // The Browser tab exists where agents may open one (the family is on for this project) or where
  // one is open anyway (turned off since, still running).
  const { data: browsers } = useBrowsers()
  const { data: appSettings } = useAppSettings()
  // The Preview tab follows the project's dev servers: shown while one listens (always on Desktop,
  // where ports can be named by hand), with their count.
  const { data: previewList } = usePreviews()
  const previewCount = projectId ? projectTargets(previewList?.targets ?? [], projectId, conversationId).length : 0
  const previewTab = projectId !== undefined && (previewCount > 0 || previewList?.mode === 'direct' || chosenTab === 'preview')
  const browserOpen = conversationId !== undefined && (browsers ?? []).some((entry) => entry.conversationId === conversationId)
  const browserTab = conversationId !== undefined && (browserOpen || resolveAgentTools(appSettings?.agentTools ?? {}, project?.agentTools ?? null).browser)
  /**
   * First render deliberately starts offscreen, entering only next render: elements born in place
   * have no transition and would appear abruptly.
   */
  const [entered, setEntered] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const aside = useRef<HTMLElement>(null)
  const refresh = useRefreshTree(filesScope)
  const wasRunning = useRef(turnRunning)
  const wide = useMediaQuery('(min-width: 48rem)')
  const modal = !wide || fullscreen

  // History and Git resolve paths in the session even when Files displays another folder.
  const openInFiles = (path: string) => openPanelFile(scope, path)

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
      data-files-scope={filesScope}
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
          {projectId ? <>
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
          {previewTab ? (
            <Tab
              icon={<MonitorPlay size={20} />}
              label={t('panel.tab.preview')}
              badge={previewCount}
              active={tab === 'preview'}
              onSelect={() => setPanelTab('preview')}
            />
          ) : null}
          </> : null}
          {conversationId && cardId ? (
            <Tab
              icon={<SquareKanban size={20} />}
              label={t('panel.tab.card')}
              active={tab === 'card'}
              onSelect={() => setPanelTab('card')}
            />
          ) : null}
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
              {browserTab ? (
                <Tab
                  icon={<Globe size={20} />}
                  label={t('panel.tab.browser')}
                  badge={browserOpen ? 1 : 0}
                  active={tab === 'browser'}
                  onSelect={() => setPanelTab('browser')}
                />
              ) : null}
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
      {/* `pr-1` puts the toggle 4px from the edge, where page headers put theirs. */}
      <header className="flex min-h-[var(--header-height)] shrink-0 flex-wrap items-center gap-y-1 border-b border-line py-1 pr-1 pl-1.5">
        <div className="min-w-0 flex-1 pl-2">
          <h2 className="truncate text-sm font-medium text-ink">{t(`panel.tab.${tab}`)}</h2>
          {tab === 'files' ? <FolderSwitcher key={scope} scope={scope} projectId={projectId} selected={folder} rootPath={worktreePath ?? project?.workspacePath ?? ''} />
            : fullscreen ? <p title={workspaceLabel} className="hidden truncate text-xs text-ink-faint md:block">{workspaceLabel}</p> : null}
        </div>

        {/* The tab's own actions first, then how the panel sits in the window, then the way out. */}
        <div className="flex shrink-0 items-center gap-0.5 pl-1">
          {tab === 'files' ? (
            <>
              {/*
               * The explorer carries its own search and refresh, so this bar repeats neither. Quick
               * open only stands in while the explorer is put away, left of the toggle that hid it
               * so that toggle does not move.
               */}
              {treeOpen ? null : (
                <IconButton size="sm" label={t('editor.quickOpen.title')} aria-keyshortcuts="Control+P Meta+P" onClick={() => setQuickOpen(true)}><Search size={16} /></IconButton>
              )}
              <IconButton
                label={treeOpen ? t('panel.tree.hide') : t('panel.tree.show')}
                size="sm"
                aria-pressed={treeOpen}
                onClick={() => setPanelTree(!treeOpen)}
              >
                {/* Not a panel glyph: beside the panel toggle it read as a second one. */}
                <FolderTree size={16} className={cx(treeOpen && 'text-accent')} />
              </IconButton>
              <span aria-hidden className="mx-1.5 h-4 w-px bg-line" />
            </>
          ) : null}
          {/*
           * Three glyph families for three different moves: panes for where the panel sits, corner
           * brackets for full screen, and diagonal arrows left to the page's concentration mode.
           */}
          {canDock && !fullscreen ? (
            <IconButton
              label={t(docked ? 'panel.expand' : 'panel.dock')}
              size="sm"
              onClick={() => setPanelExpanded(docked)}
            >
              {docked ? <Layers2 size={16} /> : <Columns2 size={16} />}
            </IconButton>
          ) : null}
          {wide || fullscreen ? <IconButton size="sm" label={t(fullscreen ? 'panel.fullscreen.exit' : 'panel.fullscreen.enter')} onClick={() => setFullscreen((value) => !value)}>
            {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
          </IconButton> : null}
          <PanelToggle data-panel-initial-focus />
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
        <FilesPane key={filesScope} scope={filesScope} />
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
          {projectId ? <TerminalsPane
            projectId={projectId}
            conversationId={conversationId}
            visible={tab === 'terminals'}
          /> : null}
        </div>
      </div>

      {tab === 'actions' && projectId ? <ActionsPane projectId={projectId} conversationId={conversationId} /> : null}

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
          workflows={workflows}
          selectedId={selectedSubAgent}
        />
      ) : null}

      {/* Like subagents, log-derived content loses nothing by mounting only when viewed. */}
      {tab === 'preview' && projectId ? <PreviewPane key={projectId} projectId={projectId} conversationId={conversationId} /> : null}

      {tab === 'browser' && conversationId ? <BrowserPane conversationId={conversationId} /> : null}

      {tab === 'mcp' ? <McpPane servers={mcpServers} conversationId={conversationId} agent={agent} /> : null}

      {tab === 'card' && projectId && cardId ? <CardPane projectId={projectId} cardId={cardId} onChange={cardActions?.change} onDetach={cardActions?.detach} detaching={cardActions?.detaching} /> : null}

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
      <QuickOpen key={filesScope} scope={filesScope} workspaceLabel={folder?.path ?? workspaceLabel} open={open && quickOpen} onOpenChange={setQuickOpen} onSelect={(path) => openPanelFile(filesScope, path)} />
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
