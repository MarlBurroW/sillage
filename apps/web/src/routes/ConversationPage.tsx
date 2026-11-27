import { conversationPath } from '@sillage/protocol'
import { useConcentration } from '../lib/concentration'
import { Loader } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AGENT_CAPABILITIES } from '@sillage/protocol'
import { AGENT_LABELS } from '../components/AgentIcon'
import { refreshFileLinks } from '../lib/file-links'
import { Composer } from '../components/chat/Composer'
import { ConversationStatusBar } from '../components/chat/status-bar/ConversationStatusBar'
import { ConversationMinimap } from '../components/chat/ConversationMinimap'
import { ConversationWorktreeBar } from '../components/chat/ConversationWorktreeBar'
import { ThreadSearch } from '../components/chat/ThreadSearch'
import { useAgentModels, useMentionableAgents } from '../lib/agents'
import { syncClaudeConversation } from '../lib/claude-sessions'
import { cx } from '../components/ui'
import {
  useHandoff,
  interruptConversation,
  useAllConversations,
  useConversation,
} from '../lib/conversations'
import { useFileDrop } from '../lib/file-drop'
import { useConversationConfig } from '../lib/conversation-config'
import { CardRefContext } from '../lib/card-refs'
import { FileLinkContext } from '../lib/file-links'
import { useTranslate } from '../lib/i18n'
import { clearSubAgent, setPanelOpen, setPanelTab, usePanelLayout, usePanelPresence, usePanelTab } from '../lib/panel'
import { useProjects } from '../lib/projects'
import { useTrackRead } from '../lib/reads'
import { useCurrentUser } from '../lib/session'
import { describeActivity } from '../lib/chat-fold'
import { useRunningToolLabel } from '../lib/tool-style'
import { messageHistory } from '../lib/turns'
import { SignalRow } from '../components/chat/Signals'
import { useChatStream } from '../lib/use-chat-stream'
import { useWorktrees } from '../lib/worktrees'
import { useStatusBar } from '../lib/status-bar'
import { ConversationCommands } from './conversation/ConversationCommands'
import { ConversationDialogs } from './conversation/ConversationDialogs'
import { ConversationHeader } from './conversation/ConversationHeader'
import { ConversationSidePanel } from './conversation/ConversationSidePanel'
import { ConversationThreadContent } from './conversation/ConversationThreadContent'
import { ThreadScrollControls } from './conversation/ThreadScrollControls'
import { useConversationActions } from './conversation/use-conversation-actions'
import { useConversationDialogs } from './conversation/use-conversation-dialogs'
import { useConversationSignals, useThreadModel } from './conversation/use-thread-model'
import { scrollToBottom, useThreadPlacement } from './conversation/use-thread-placement'
import { useThreadPositioning } from './conversation/use-thread-positioning'
import { useThreadWindow } from './conversation/use-thread-window'
import { useTurnNavigation } from './conversation/use-turn-navigation'

/**
 * The conversation screen. Logic lives in the `conversation/` hooks, called in the order their
 * layout effects must run: placement, window, turn navigation, then positioning.
 */
export function ConversationPage() {
  const t = useTranslate()
  const { conversationId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  // Draft passed by a fork: the cut message returns to the composer.
  const draft = (useLocation().state as { draft?: string } | null)?.draft ?? ''
  const queryClient = useQueryClient()
  const { data: user } = useCurrentUser()
  const { data: conversation } = useConversation(conversationId)
  useEffect(() => {
    if (!conversation || location.pathname === conversationPath(conversation)) return
    // Old project URLs and agent-triggered moves follow the same stable conversation ID.
    navigate(conversationPath(conversation) + location.search + location.hash, { replace: true })
    refreshFileLinks(conversation.id)
    for (const key of ['tree', 'tree-search', 'tree-content', 'git', 'commits']) {
      void queryClient.invalidateQueries({ queryKey: [key, conversation.id] })
    }
  }, [conversation, location.pathname, location.search, location.hash, navigate, queryClient])
  const stream = useChatStream(conversationId, conversation?.status ?? 'idle')
  // ↑ in the composer: the user's own messages, sent or still queued.
  const history = useMemo(() => messageHistory(stream.state.items, stream.state.queued), [stream.state.items, stream.state.queued])
  // Viewing the page counts as reading: the sidebar need not flag what is already visible.
  //
  // The row's `seq` takes precedence over the folded thread: opening a conversation
  // acknowledges all of it, not just what has arrived. Journal loading is paginated,
  // and relying on it marked a short visit to a long thread as read only through
  // the first page, leaving it unread. The thread takes over once it advances
  // past the row, since it progresses during a turn.
  useTrackRead(conversationId, Math.max(conversation?.lastSeq ?? 0, stream.state.lastSeq))
  // The catalog carries account type, determining whether a monetary amount is meaningful.
  // Like all hooks, keep this before the first early return. Probing starts the CLI
  // server-side, so only probe the conversation's agent.
  const { data: catalog } = useAgentModels(conversation?.agent ?? 'claude', Boolean(conversation))
  const mentionable = useMentionableAgents(conversation?.agent ?? 'claude', Boolean(conversation))
  const { data: worktrees } = useWorktrees(conversation?.projectId)
  // Already loaded for the sidebar: fork origin is available without an extra
  // request.
  const { data: allConversations } = useAllConversations()

  const scroller = useRef<HTMLDivElement>(null)
  const placement = useThreadPlacement(scroller, conversationId)
  const { placed, stuckToBottom, setStuckToBottom, slowReplay } = placement

  const { turns, rows, subAgents, workflowTasks, runningSubAgents, background, loops, now } = useThreadModel(stream)
  // Read through the schema rather than casting: configurations saved before new
  // fields gain defaults rather than arriving with holes.
  // Declared here, not after early returns as before: the signal row needs it,
  // and hooks cannot be declared farther down.
  const { config, error: configError, change: updateConfig, retry: retryConfig, flush: flushConfig } = useConversationConfig(conversation)
  const { billingAccount, signals } = useConversationSignals({
    conversation, config, catalog, stream, runningSubAgents, background, loops, now,
  })
  const dialogs = useConversationDialogs()
  const { findOpen, setFindOpen } = dialogs
  const actions = useConversationActions({ conversationId, projectId: conversation?.projectId, flushConfig })

  const { view, scrollAnchor, reveal, showEarlier, growWindowTo } = useThreadWindow({
    conversationId, rows, findOpen, stream, scroller,
  })
  const { turnAnchors, visibleTurns, flashed, setFlashed, syncVisibleTurns, jumpToTurn, step } = useTurnNavigation({
    scroller, turns, view, reveal, scrollAnchor, items: stream.state.items, lastSeq: stream.state.lastSeq,
  })
  const { onScroll } = useThreadPositioning({
    scroller, conversationId, conversation, stream, placement, growWindowTo, syncVisibleTurns, setFlashed,
  })

  const runningTool = useRunningToolLabel()
  const activity = describeActivity(stream.state, runningTool)
  const concentration = useConcentration()
  const statusBar = useStatusBar()
  // Context on the status line takes the composer gauge's place, except in concentration mode,
  // which hides the line and would otherwise leave no gauge at all.
  const contextInBar = !concentration && statusBar.items.some((item) => item.key === 'context' && item.on)
  const panel = usePanelPresence()
  const panelLayout = usePanelLayout()
  const panelTab = usePanelTab()
  const { data: projects } = useProjects()
  // The entire thread accepts files, not just the composer: users drop screenshots
  // onto the conversation, and aiming for a 40-pixel-high field is difficult
  // with either touch or a mouse.
  const drop = useFileDrop(conversation !== undefined && conversation.userId === user?.id)

  /**
   * Thread search takes over the browser's search shortcut.
   *
   * Expected app behavior: native search cannot count or navigate occurrences within an
   * independently scrolling container. Browser search remains accessible through its menu.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return

      // Within the panel, the editor should search its file: without this division,
      // the shortcut opened both searches simultaneously.
      // Use `data-panel`, not translated `aria-label`: changing language must not
      // break detection.
      const target = event.target
      if (target instanceof Element && target.closest('[data-panel="workspace"]')) return

      event.preventDefault()
      setFindOpen(true)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setFindOpen])

  /**
   * Catch up on turns performed in the Claude Code CLI outside Sillage.
   *
   * The CLI always rereads the full transcript, but the journal is a separate copy: without
   * catch-up on opening, sessions continued in a terminal would appear truncated here.
   * Recovered events arrive through the WebSocket subscription like live events, requiring no
   * reload.
   */
  useEffect(() => {
    if (!conversationId || !conversation?.isOwner) return
    if (!AGENT_CAPABILITIES[conversation.agent].resyncSessions) return
    syncClaudeConversation(conversationId).catch((err: unknown) => {
      // Failed catch-up does not prevent conversation use, but hiding it would make
      // apparently incomplete threads impossible to diagnose.
      console.error('Resynchronisation du transcript CLI impossible :', err)
    })
  }, [conversationId, conversation?.agent, conversation?.isOwner])

  // Spawn calls exist only within their thread: retaining selection across conversations
  // would open the panel on a nonexistent sub-agent.
  useEffect(() => clearSubAgent, [conversationId])

  // The title lives in the conversation row, not the journal: reread it at turn end,
  // when the CLI may have suggested one.
  useEffect(() => {
    if (!stream.state.turnRunning && conversationId) {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
    }
  }, [stream.state.turnRunning, conversationId, queryClient])

  // Also refresh the header branch, but only after a live turn: a checkout may have
  // changed it. Cached state suffices on opening; rereading every project's git
  // state on each navigation would be needless overhead.
  const turnWasRunning = useRef(false)
  useEffect(() => {
    if (turnWasRunning.current && !stream.state.turnRunning) {
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      void queryClient.invalidateQueries({ queryKey: ['worktrees'] })
    }
    turnWasRunning.current = stream.state.turnRunning
  }, [stream.state.turnRunning, queryClient])

  // Prepared continuations must show their context before the first message.
  const emptyThread = !stream.loading && stream.state.items.length === 0
  const handoff = useHandoff(conversationId, (dialogs.metaOpen || emptyThread) && Boolean(conversation?.handoffFromId))

  // `config` is null exactly when the conversation is, but the type system does not
  // know it: include it in the guard instead of forcing it later.
  if (!conversationId || !conversation || !config) return null

  const isOwner = conversation.userId === user?.id
  const cardShown = panel.open && panelTab === 'card' && Boolean(conversation.card)
  const showCard = () => {
    setPanelTab('card')
    setPanelOpen(true)
  }
  // Steering requires an open turn and a capable CLI: offering it elsewhere would
  // advertise an action the server rejects.
  const canSteer =
    isOwner &&
    AGENT_CAPABILITIES[conversation.agent].steer &&
    (stream.status === 'running' || stream.status === 'awaiting_input')
  const worktree = worktrees?.find((entry) => entry.id === conversation.worktreeId)
  const project = projects?.find((entry) => entry.id === conversation.projectId)
  const origin = conversation.forkedFromId
    ? allConversations?.find((entry) => entry.id === conversation.forkedFromId)
    : undefined
  const continued = conversation.handoffFromId
    ? allConversations?.find((entry) => entry.id === conversation.handoffFromId)
    : undefined

  const canCompact = isOwner && AGENT_CAPABILITIES[conversation.agent].compact
  const compactBusy = actions.compacting || stream.state.compacting
  const canMove = isOwner && Boolean(conversation.projectId) && !conversation.scheduleId && !conversation.benchmarkId
  const turnOpen = stream.status === 'running' || stream.status === 'awaiting_input'

  // `relative` anchors the back-to-bottom button; height excludes the shell's mobile
  // header, absent on desktop.
  return (
    // This conversation's workspace resolves paths mentioned in the thread: it, not
    // the project, determines what relative paths mean when the conversation runs
    // inside a worktree.
    <FileLinkContext.Provider value={conversationId}>
    {/* Thread `#12` references identify this project's board cards. */}
    <CardRefContext.Provider value={conversation.projectId}>
    {/* `overflow-clip`, not `hidden`: hidden containers remain programmatically scrollable. An editor revealing a line while the panel slid out shifted the container, leaving the panel clipped on the left. */}
    <div ref={panelLayout.containerRef} className={cx("relative flex h-full overflow-clip", concentration && "sg-concentration")}>
      <div
        className={cx(
          // `@container`: the ruler and composer settings collapse according to actual
          // thread width, not window width, which does not account for
          // the sidebar.
          // `h-full`: height comes from the root layer, which already follows the visual
          // viewport. Local calculation would duplicate shell knowledge.
          '@container/thread relative flex h-full min-w-0 flex-1 flex-col pb-safe',
        )}
        {...drop.handlers}
      >
        {/*
         * Drop overlay without pointer capture: an interactive layer would interrupt the drag
         * it announces.
         */}
        {drop.dragging ? (
          <div
            className={cx(
              'pointer-events-none absolute inset-2 z-30 flex items-center justify-center',
              'rounded-xl border-2 border-dashed border-accent bg-canvas/80 text-sm text-accent',
            )}
          >
            {t('conversation.drop.attach')}
          </div>
        ) : null}

        <ConversationCommands
          conversationId={conversationId}
          conversation={conversation}
          status={stream.status}
          isOwner={isOwner}
          canCompact={canCompact}
          compactBusy={compactBusy}
          canMove={canMove}
          turnOpen={turnOpen}
          compact={actions.compact}
          showCard={showCard}
          dialogs={dialogs}
        />

        <ConversationHeader
          conversationId={conversationId}
          conversation={conversation}
          project={project}
          worktree={worktree}
          worktreesLoaded={worktrees !== undefined}
          signals={signals}
          concentration={concentration}
          isOwner={isOwner}
          canCompact={canCompact}
          compactBusy={compactBusy}
          canMove={canMove}
          idle={stream.status === 'idle'}
          cardShown={cardShown}
          showCard={showCard}
          compact={actions.compact}
          panelReplaced={panelLayout.docked && panel.mounted}
          dialogs={dialogs}
        />
        {!concentration && !conversation.projectId && allConversations?.some(entry => entry.handoffFromId === conversation.id && entry.projectId) ? <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2 text-xs text-ink-soft">
          <span>{t('discussions.project.linked')}</span>
          {allConversations.filter(entry => entry.handoffFromId === conversation.id && entry.projectId).map(entry => <Link key={entry.id} to={conversationPath(entry)} className="text-accent hover:underline">{entry.title}</Link>)}
        </div> : null}
        {!concentration ? <ConversationWorktreeBar key={conversation.id} conversation={conversation} canClean={project?.isOwner ?? false} /> : null}

        <ConversationDialogs
          conversationId={conversationId}
          conversation={conversation}
          config={config}
          isOwner={isOwner}
          state={stream.state}
          worktree={worktree}
          origin={origin}
          continued={continued}
          handoff={handoff.data}
          billingAccount={billingAccount}
          showCard={showCard}
          forking={actions.forking}
          forkTarget={actions.forkTarget}
          setForkTarget={actions.setForkTarget}
          fork={actions.fork}
          dialogs={dialogs}
        />

        <ThreadSearch
          scroller={scroller}
          open={findOpen}
          onClose={() => setFindOpen(false)}
          revision={stream.state.lastSeq + stream.state.items.length}
          loading={(stream.hasMore && !stream.error) || stream.loadingOlder}
        />

        {/*
         * Positioning context for the waiting indicator: inside the thread, it would align with
         * content and move offscreen once content exceeds viewport height.
         */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {!placed && slowReplay ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
              <Loader
                size={22}
                className="animate-spin text-ink-faint"
                aria-label={t('conversation.loading')}
              />
            </div>
          ) : null}

          <div
            ref={scroller}
            onScroll={onScroll}
            className="fade-bottom relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            {/*
             * Only the side ruler needs gutters, and only where visible. Keep them symmetrical
             * to center the thread. No right reservation: navigation arrows sit above the
             * composer outside the thread.
             */}
            {/*
             * Hidden, not unmounted, until positioned: placement needs measured heights,
             * unavailable outside layout. Fade in, disappear immediately: on conversation
             * switches, the disappearing thread is the previous one.
             */}
            <ConversationThreadContent
              conversationId={conversationId}
              conversation={conversation}
              stream={stream}
              placed={placed}
              actionError={actions.actionError}
              emptyThread={emptyThread}
              handoff={handoff}
              onStartContinuation={() => actions.send(t('conversation.continuation.prompt'), [], [], [])}
              view={view}
              showEarlier={showEarlier}
              workflowTasks={workflowTasks}
              mayCollapseTools={!placed || stuckToBottom}
              revealTools={findOpen}
              isOwner={isOwner}
              canSteer={canSteer}
              forking={actions.forking}
              onFork={actions.setForkTarget}
              flashed={flashed}
              turnAnchors={turnAnchors}
              onRestoreCheckpoint={dialogs.setRestoreTarget}
              activity={activity}
              concentration={concentration}
            />
          </div>

          {/*
           * Place within the thread area, not the whole column: centering on the column moved
           * it beneath the growing composer. Show it with the thread too: a ruler filling
           * beside an empty thread reveals the construction hidden by masking.
           */}
          {placed && !concentration ? (
            <ConversationMinimap
              turns={turns}
              visibleIds={visibleTurns}
              agentLabel={AGENT_LABELS[conversation.agent]}
              onJump={jumpToTurn}
            />
          ) : null}
        </div>

        {/*
         * Scroll controls sit immediately above the variable-height composer: `bottom-full`
         * anchors them without a fixed offset. Useful only while detached from the bottom, so
         * hide them upon returning.
         */}
        <div className="relative shrink-0">
          {placed && !stuckToBottom ? (
            <ThreadScrollControls
              onBottom={() => {
                const node = scroller.current
                if (node) scrollToBottom(node)
                setStuckToBottom(true)
              }}
              turnCount={turns.length}
              onStep={step}
              concentration={concentration}
            />
          ) : null}

          {/*
           * Above the composer, not below: the last thing read before typing. Match composer
           * width to form one block. `TurnActivity` reports the same activity within the thread
           * but scrolls away; this row stays.
           */}
          <SignalRow
            signals={signals}
            onSelect={() => setPanelOpen(true)}
            className="mx-auto sg-conversation-width px-1.5 pb-2"
          />

          <Composer
            key={conversationId}
            initialText={draft}
            draftKey={conversationId}
            config={config}
            status={stream.status}
            disabled={!isOwner}
            context={contextInBar ? null : stream.state.context}
            onSteer={canSteer ? actions.steer : undefined}
            onSend={actions.send}
            agents={mentionable}
            onCommand={actions.runCommand}
            onInterrupt={() => void interruptConversation(conversationId)}
            onConfigChange={updateConfig}
            configError={configError?.message}
            onConfigRetry={retryConfig}
            mcpInventory={stream.state.mcp}
            commands={stream.state.commands}
            skills={stream.state.skills}
            appliedConfig={stream.appliedConfig}
            projectId={conversation.projectId}
            worktreeId={conversation.worktreeId}
            history={history}
            footer={
              <ConversationStatusBar
                conversation={conversation}
                stream={stream}
                config={config}
                runningSubAgents={runningSubAgents}
                background={background}
                items={statusBar.items}
                onOpenUsage={() => dialogs.setUsageOpen(true)}
                onOpenDetails={() => dialogs.setMetaOpen(true)}
              />
            }
          />
        </div>
      </div>

      <ConversationSidePanel
        conversationId={conversationId}
        conversation={conversation}
        worktree={worktree}
        stream={stream}
        isOwner={isOwner}
        subAgents={subAgents}
        background={background}
        workflowTasks={workflowTasks}
        panel={panel}
        panelLayout={panelLayout}
        onChangeCard={() => dialogs.setCardLinkOpen(true)}
      />
    </div>
    </CardRefContext.Provider>
    </FileLinkContext.Provider>
  )
}
