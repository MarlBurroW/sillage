import { CreateProjectDialog } from '../components/chat/CreateProjectDialog'
import { conversationPath } from '@sillage/protocol'
import { recordPerformance } from '../lib/performance-diagnostics'
import { useConcentration } from '../lib/concentration'
import { ConcentrationButton } from '../components/chat/ConcentrationButton'
import { useThreadLayout } from '../lib/use-thread-layout'
import { NewsTicker } from '../components/chat/NewsTicker'
import { TooltipButton, TooltipProvider } from '../components/ui/Tooltip'
import * as Dialog from '@radix-ui/react-dialog'
import {
  ArrowDown,
  ArrowRightLeft,
  Info,
  X,
  FileText,
  FolderTree,
  FolderPlus,
  GaugeCircle,
  GitBranch,
  SquareKanban,
  Loader,
  PanelRight,
  Search,
  Shrink,
  Terminal,
} from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AGENT_CAPABILITIES } from '@sillage/protocol'
import { AGENT_LABELS, AgentIcon } from '../components/AgentIcon'
import { ChatThread } from '../components/chat/ChatThread'
import { ContinuationIntro } from '../components/chat/ContinuationIntro'
import { HandoffDialog } from '../components/chat/HandoffDialog'
import { appliedPermissionLabel } from '../components/chat/agent-settings'
import { Composer } from '../components/chat/Composer'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { ComposerStatus } from '../components/chat/ComposerStatus'
import { ConversationMinimap } from '../components/chat/ConversationMinimap'
import { PromptSuggestion } from '../components/chat/PromptSuggestion'
import { QueuedMessages } from '../components/chat/QueuedMessages'
import { HeldSessionMessages } from '../components/chat/HeldSessionMessages'
import { ConversationWorktreeBar } from '../components/chat/ConversationWorktreeBar'
import { WorkspaceLabel } from '../components/chat/WorkspaceLabel'
import { ThreadSearch } from '../components/chat/ThreadSearch'
import { TurnActivity } from '../components/chat/TurnActivity'
import { TurnNav } from '../components/chat/TurnNav'
import { UsagePanel } from '../components/chat/UsagePanel'
import { RestoreCheckpointDialog } from '../components/chat/RestoreCheckpointDialog'
import { usageAccountOf } from '../lib/usage'
import { useClaudeAccounts } from '../lib/claude-accounts'
import { UsageSummary } from '../components/chat/UsageSummary'
import { useAgentModels } from '../lib/agents'
import { syncClaudeConversation } from '../lib/claude-sessions'
import { Banner, ConfirmDialog, EmptyState, IconButton, cx } from '../components/ui'
import {
  compactConversation,
  conversationsKey,
  forkConversation,
  useHandoff,
  interruptConversation,
  sendMessage,
  steerConversation,
  useAllConversations,
  useConversation,
  useSetConversationCard,
} from '../lib/conversations'
import { useFileDrop } from '../lib/file-drop'
import { useConversationConfig } from '../lib/conversation-config'
import { CardRefContext } from '../lib/card-refs'
import { FileLinkContext } from '../lib/file-links'
import { useTranslate } from '../lib/i18n'
import { InstructionsDialog } from '../components/instructions/Instructions'
import { clearSubAgent, setPanelOpen, setPanelTab, showCheckpoint, usePanelLayout, usePanelPresence, usePanelTab } from '../lib/panel'
import { CardLinkDialog } from '../components/chat/CardLinkDialog'
import { columnLabel } from '../components/board/columns'
import { useProjects } from '../lib/projects'
import { useTrackRead } from '../lib/reads'
import { useCurrentUser } from '../lib/session'
import { useSidebarHidden } from '../lib/sidebar'
import { describeActivity, type MessageItem, type TurnCheckpoint } from '../lib/chat-fold'
import { buildBackground, type BackgroundWork } from '../lib/background'
import { buildLoops, type ArmedLoop } from '../lib/loops'
import { buildSignals, type SignalKind } from '../lib/signals'
import { SignalRow } from '../components/chat/Signals'
import { buildSubAgents } from '../lib/subagents'
import { buildRows } from '../lib/tool-rows'
import { readThreadScroll, saveThreadScroll } from '../lib/thread-scroll'
import {
  INITIAL_WINDOW_ROWS,
  WINDOW_STEP_ROWS,
  windowRows,
  windowToReveal,
} from '../lib/thread-window'
import { buildTurns } from '../lib/turns'
import { useChatStream } from '../lib/use-chat-stream'
import { useWorktrees } from '../lib/worktrees'
import { ActionsLauncher } from '../components/actions/ActionsLauncher'

/**
 * Lazy-loaded: the editor bundles CodeMirror, and including it initially would charge every
 * conversation opening for a panel users may never open.
 */
const SidePanel = lazy(() =>
  import('../components/panel/SidePanel').then((m) => ({ default: m.SidePanel })),
)

/** Singleton: recreating an empty list on every render would rerender the panel. */
const NO_BACKGROUND: BackgroundWork[] = []
const NO_LOOPS: ArmedLoop[] = []

/** Header-retained states indicating that displayed content is no longer current. */
const HEADER_SIGNALS = new Set<SignalKind>(['error', 'interrupted', 'offline'])

/** Infrequent enough for minute-level age display, frequent enough to stay truthful. */
const TICK_MS = 30_000

function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [active])

  return now
}

/** Distance within which the user is considered to be following the thread bottom. */
const STICKY_THRESHOLD_PX = 120

/** Must cover the `sg-flash-turn` animation, otherwise the ring cuts off abruptly. */
const FLASH_DURATION_MS = 1500

/**
 * Beyond this, journal replay is no longer instant and needs an indicator.
 *
 * Hide the thread while it builds, sufficient for one or two frames. A twenty-thousand-event
 * thread requires roughly forty sequential pages, each cursor derived from the previous page's
 * last `seq`; hiding alone would make the screen look dead. Delay long enough that ordinary
 * conversations open without ever showing it.
 */
const SLOW_REPLAY_MS = 400

/**
 * Scroll the thread all the way down.
 *
 * Calculate the target instead of relying on clamping an oversized `scrollTop`, then reapply
 * next frame: code blocks and images still change thread height after the jump, and targeting
 * an outdated height stops short of the end.
 */
function scrollToBottom(node: HTMLElement): void {
  node.scrollTop = node.scrollHeight - node.clientHeight
  requestAnimationFrame(() => {
    node.scrollTop = node.scrollHeight - node.clientHeight
  })
}

export function ConversationPage() {
  const t = useTranslate()
  const { conversationId } = useParams()
  const navigate = useNavigate()
  // Draft passed by a fork: the cut message returns to the composer.
  const draft = (useLocation().state as { draft?: string } | null)?.draft ?? ''
  const queryClient = useQueryClient()
  const { data: user } = useCurrentUser()
  const { data: conversation } = useConversation(conversationId)
  const stream = useChatStream(conversationId, conversation?.status ?? 'idle')
  const { loadOlder } = stream
  const currentThread = useRef(conversationId)
  currentThread.current = conversationId
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
  const { data: worktrees } = useWorktrees(conversation?.projectId)
  // Already loaded for the sidebar: fork origin is available without an extra
  // request.
  const { data: allConversations } = useAllConversations()

  const scroller = useRef<HTMLDivElement>(null)
  const [stuckToBottom, setStuckToBottom] = useState(true)
  /**
   * Position from the last scroll event, used to recognize a reading gesture.
   *
   * Following the bottom cannot rely solely on distance to it: content continues growing after
   * snapping, as code highlights or images load, so the snap event is processed against an
   * already changed height. The thread appeared abandoned, follow mode stopped, and live output
   * continued screens below the reader. Growing height never lowers `scrollTop`, and snapping
   * only raises it: now only an upward gesture detaches the thread.
   */
  const lastTop = useRef(0)
  /**
   * The thread is positioned and ready to show.
   *
   * False throughout journal replay: content is built in batches at a meaningless position, and
   * exposing it would show scaffolding. Also false during conversation switches while the
   * previous thread remains mounted.
   */
  const [placed, setPlaced] = useState(false)
  useThreadLayout(scroller, stuckToBottom, placed)
  /** Replay has lasted long enough for a hidden thread to look like a dead screen. */
  const [slowReplay, setSlowReplay] = useState(false)

  /** Each turn's position in the thread, populated from user messages. */
  const turnAnchors = useRef(new Map<string, HTMLElement>())
  const [visibleTurns, setVisibleTurns] = useState<Set<string>>(() => new Set())
  const visibilityFrame = useRef<number | null>(null)

  const turns = useMemo(() => buildTurns(stream.state.items), [stream.state.items])
  const rows = useMemo(() => buildRows(stream.state.items, null, stream.state.turnRunning), [stream.state.items, stream.state.turnRunning])
  const subAgents = useMemo(
    () => buildSubAgents(stream.state.items, stream.state.tasks),
    [stream.state.items, stream.state.tasks],
  )
  const runningSubAgents = useMemo(
    () => subAgents.filter((agent) => agent.status === 'running'),
    [subAgents],
  )
  /**
   * The journal may retain background work no process runs anymore: an abruptly killed daemon
   * cannot write the session-end event. Cold sessions have no process and thus no background
   * work, regardless of the thread.
   */
  const background = useMemo(
    () => (stream.warm === false ? NO_BACKGROUND : buildBackground(stream.state)),
    [stream.warm, stream.state],
  )
  /** Same reason as background work: scheduled tasks run only while the CLI is alive. */
  const loops = useMemo(
    () => (stream.warm === false ? NO_LOOPS : buildLoops(stream.state)),
    [stream.warm, stream.state],
  )
  /**
   * Periodic wakeup keeps last-loop-wakeup age current. Without armed loops no signal depends
   * on time, so the timer stays stopped.
   */
  const now = useTicker(loops.length > 0)
  // Read through the schema rather than casting: configurations saved before new
  // fields gain defaults rather than arriving with holes.
  // Declared here, not after early returns as before: the signal row needs it,
  // and hooks cannot be declared farther down.
  const { config, error: configError, change: updateConfig, retry: retryConfig, flush: flushConfig } = useConversationConfig(conversation)
  // The catalog describes CLI login; conversations using an additional account's API
  // key are usage-billed, where a monetary amount does make sense.
  const { data: claudeAccounts } = useClaudeAccounts(conversation?.agent === 'claude')
  const accountKind = claudeAccounts?.accounts.find((entry) => entry.id === usageAccountOf(config))?.kind ?? null
  const billingAccount =
    accountKind === 'apiKey'
      ? { subscriptionType: null, organization: null, billedBySubscription: false }
      : catalog?.account
  /**
   * Permission mode still applied by the CLI when it differs from the chosen one. Otherwise
   * null, with no signal to display.
   */
  const pendingPermission = useMemo(
    () => (config ? appliedPermissionLabel(config, stream.appliedConfig, t) : null),
    [config, stream.appliedConfig, t],
  )
  const signals = useMemo(
    () =>
      buildSignals({
        status: stream.status,
        connected: stream.connected,
        subAgents: runningSubAgents,
        background,
        loops,
        queued: stream.state.queued,
        pending: pendingPermission,
        now,
      }),
    [
      stream.status,
      stream.connected,
      runningSubAgents,
      background,
      loops,
      stream.state.queued,
      pendingPermission,
      now,
    ],
  )
  const [usageOpen, setUsageOpen] = useState(false)
  const [forking, setForking] = useState(false)
  /** Message offered for forking: too uncommon an action to trigger directly. */
  const [forkTarget, setForkTarget] = useState<MessageItem | null>(null)
  /** Turn whose workspace changes are proposed for undo. */
  const [restoreTarget, setRestoreTarget] = useState<TurnCheckpoint | null>(null)
  /** Failure of a one-off conversation action: fork or compaction. */
  const [actionError, setActionError] = useState<string | null>(null)
  const [compacting, setCompacting] = useState(false)
  /** Last turn reached by a jump, highlighted briefly for orientation. */
  const [flashed, setFlashed] = useState<string | null>(null)
  const [metaOpen, setMetaOpen] = useState(false)
  /** “Continue in another CLI” dialog: switching tools requires confirmation. */
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [instructionsOpen, setInstructionsOpen] = useState(false)

  /** Mounted row count, from the end. See `thread-window`. */
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW_ROWS)
  /** Thread position before expansion, restored after inserting earlier content. */
  const scrollAnchor = useRef<{ height: number; top: number } | null>(null)
  /** Target turn not yet mounted: jump once it is mounted. */
  const pendingJump = useRef<string | null>(null)

  // A different conversation starts from the end; otherwise it would open with as
  // many expanded rows as the previous one, unrelated to its own length.
  //
  // Before paint, resetting `placed` too: the page is not remounted between threads,
  // so the new ID's first render still contains the old thread at its old position,
  // which would briefly appear under the new title.
  useLayoutEffect(() => {
    setWindowSize(INITIAL_WINDOW_ROWS)
    setPlaced(false)
  }, [conversationId])

  // Arm the indicator only after hiding the thread, and disarm when shown:
  // ordinary conversations never reach the timeout, so nothing flashes
  // between threads.
  useEffect(() => {
    setSlowReplay(false)
    if (placed) return
    const timer = setTimeout(() => setSlowReplay(true), SLOW_REPLAY_MS)
    return () => clearTimeout(timer)
  }, [placed, conversationId])

  useEffect(() => {
    if (findOpen && stream.hasMore && !stream.loadingOlder && !stream.error && !stream.loading) void loadOlder()
  }, [findOpen, stream.hasMore, stream.loadingOlder, stream.error, stream.loading, loadOlder, stream.state.items])

  useEffect(() => {
    if (placed) recordPerformance('thread-visible')
  }, [placed])

  const view = useMemo(
    // Thread search traverses the DOM: windowing would search truncated content and
    // report too few matches. Keep everything mounted while search
    // is open.
    () => windowRows(rows, findOpen ? Number.POSITIVE_INFINITY : windowSize),
    [rows, windowSize, findOpen],
  )

  /** Mount a row preceding the window. False if absent from the thread. */
  const reveal = useCallback(
    (itemId: string) => {
      const needed = windowToReveal(rows, itemId)
      if (needed === null) return false
      setWindowSize((size) => Math.max(size, needed))
      return true
    },
    [rows],
  )

  const showEarlier = useCallback(() => {
    const expand = () => {
      if (currentThread.current !== conversationId) return
      const node = scroller.current
      if (node) scrollAnchor.current = { height: node.scrollHeight, top: node.scrollTop }
      setWindowSize((size) => size + WINDOW_STEP_ROWS)
    }
    if (view.hidden === 0 && stream.hasMore) void loadOlder().then(expand)
    else expand()
  }, [view.hidden, stream.hasMore, loadOlder, conversationId])

  /** Message targeted by a search result, once the thread loads. */
  const [searchParams] = useSearchParams()
  const anchorSeq = Number(searchParams.get('seq'))
  const hasAnchor = Number.isInteger(anchorSeq) && anchorSeq > 0
  const anchored = useRef<number | null>(null)
  const activity = describeActivity(stream.state)
  const sidebarHidden = useSidebarHidden()
  const concentration = useConcentration()
  const panel = usePanelPresence()
  const panelLayout = usePanelLayout()
  const panelTab = usePanelTab()
  const [cardLinkOpen, setCardLinkOpen] = useState(false)
  const setConversationCard = useSetConversationCard()
  const { data: projects } = useProjects()
  // The entire thread accepts files, not just the composer: users drop screenshots
  // onto the conversation, and aiming for a 40-pixel-high field is difficult
  // with either touch or a mouse.
  const drop = useFileDrop(conversation !== undefined && conversation.userId === user?.id)

  /**
   * Turns whose regions intersect the viewport. A turn spans from its user message to the next,
   * keeping long turns highlighted while reading anywhere within them.
   */
  const syncVisibleTurns = useCallback(() => {
    const node = scroller.current
    if (!node) return

    const top = node.scrollTop
    const bottom = top + node.clientHeight

    const anchors = [...turnAnchors.current.entries()]
      .map(([id, element]) => ({ id, top: element.offsetTop }))
      .sort((a, b) => a.top - b.top)

    const next = new Set<string>()
    anchors.forEach((anchor, index) => {
      const end = anchors[index + 1]?.top ?? node.scrollHeight
      if (end > top && anchor.top < bottom) next.add(anchor.id)
    })

    // A new set on every scroll event would continuously redraw the ruler:
    // replace state only when it actually changes.
    setVisibleTurns((current) =>
      current.size === next.size && [...next].every((id) => current.has(id)) ? current : next,
    )
  }, [])

  /**
   * Remember the reading position to reopen where the user left off.
   *
   * Use the topmost displayed message: elements follow document order, so the last whose top
   * passed above the edge is the current message. None above means the reader precedes the
   * first message, which then suffices.
   */
  const rememberScroll = useCallback(
    (node: HTMLElement) => {
      if (!conversationId) return

      const top = node.scrollTop
      if (node.scrollHeight - top - node.clientHeight < STICKY_THRESHOLD_PX) {
        saveThreadScroll(conversationId, { atBottom: true, seq: 0, offset: 0 })
        return
      }

      let anchor: HTMLElement | null = null
      for (const element of node.querySelectorAll<HTMLElement>('[data-seq]')) {
        if (anchor && element.offsetTop > top) break
        anchor = element
      }
      if (!anchor) return

      const seq = Number(anchor.dataset.seq)
      if (!Number.isInteger(seq)) return
      saveThreadScroll(conversationId, { atBottom: false, seq, offset: anchor.offsetTop - top })
    },
    [conversationId],
  )

  const onScroll = useCallback(() => {
    const node = scroller.current
    // While the thread builds, heights change with each folded batch and snapping
    // is reapplied. Resulting scroll events say nothing about reader intent;
    // treating them as intentional detached the thread from its bottom
    // before it even appeared.
    if (!node || !placed) return

    // One-pixel tolerance: mobile scrolling is fractional, and rounding noise during
    // downward momentum would otherwise look like upward movement.
    const top = node.scrollTop
    const wentUp = top < lastTop.current - 1
    lastTop.current = top

    // The bottom takes precedence: it also applies when content shrinks and the browser
    // clamps `scrollTop`, moving the position upwards without user scrolling.
    if (node.scrollHeight - top - node.clientHeight < STICKY_THRESHOLD_PX) setStuckToBottom(true)
    else if (wentUp) setStuckToBottom(false)

    if (visibilityFrame.current !== null) return
    visibilityFrame.current = requestAnimationFrame(() => {
      visibilityFrame.current = null
      syncVisibleTurns()
      rememberScroll(node)
    })
  }, [syncVisibleTurns, rememberScroll, placed])

  const jumpToTurn = useCallback(
    (id: string) => {
      const node = scroller.current
      if (!node) return

      const anchor = turnAnchors.current.get(id)
      // The ruler lists all turns, including those before the window: mount them, then
      // resume the jump from the layout effect once the anchor exists.
      if (!anchor) {
        if (reveal(id)) pendingJump.current = id
        return
      }

      // `scrollTo`, not `scrollIntoView`: the latter also scrolls parent containers,
      // including the entire page on mobile.
      node.scrollTo({ top: anchor.offsetTop - 12, behavior: 'smooth' })
      // In dense threads, landing without knowing where is little better than not moving:
      // highlight the destination message.
      setFlashed(id)
    },
    [reveal],
  )

  // Delay jumps until the target turn mounts, and reposition after expansion.
  // Both scroll corrections must precede paint; otherwise the thread visibly
  // starts in the wrong place then corrects itself.
  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return

    const jump = pendingJump.current
    if (jump) {
      const anchor = turnAnchors.current.get(jump)
      if (!anchor) return
      pendingJump.current = null
      // No animation: the turn just appeared, and sliding from a position that did not
      // exist at click time conveys nothing useful.
      node.scrollTo({ top: anchor.offsetTop - 12 })
      setFlashed(jump)
      return
    }

    const saved = scrollAnchor.current
    if (!saved) return
    scrollAnchor.current = null
    node.scrollTop = saved.top + (node.scrollHeight - saved.height)
  }, [view.rows])

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
  }, [])

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

  // The ring clears itself; otherwise it would remain on a long-abandoned message
  // and stop meaning “you just arrived here”.
  useEffect(() => {
    if (!flashed) return
    const timer = setTimeout(() => setFlashed(null), FLASH_DURATION_MS)
    return () => clearTimeout(timer)
  }, [flashed])

  /**
   * Mount a message before the window by its `seq`.
   *
   * Return true while a page request or window expansion will produce another render. Both
   * opening paths keep the thread hidden until the requested message can be positioned.
   */
  const growWindowTo = useCallback(
    (seq: number): boolean => {
      const target = stream.state.items.find(
        (item) => item.kind === 'message' && item.seq === seq,
      )
      if (!target) {
        if (stream.hasMore && !stream.error) {
          if (!stream.loadingOlder) void loadOlder()
          return true
        }
        return false
      }
      const needed = windowToReveal(rows, target.id)
      if (needed === null || needed <= windowSize) return false
      setWindowSize(needed)
      return true
    },
    [stream.state.items, rows, windowSize, stream.hasMore, stream.error, stream.loadingOlder, loadOlder],
  )

  /**
   * Open at a specific message when arriving from search.
   *
   * Fetch earlier pages and expand the rendering window until the message is mounted. Once per target
   * only, otherwise every received event would reset scrolling for the session's remainder.
   */
  useLayoutEffect(() => {
    const node = scroller.current
    // Depend on `conversation` for the same reason as positioning below: it determines
    // whether the thread is mounted and has a measurable node.
    if (stream.loading || !conversation || !node) return
    if (!hasAnchor || anchored.current === anchorSeq) return
    if (growWindowTo(anchorSeq)) return

    // No more pages can supply this target; do not hide the thread forever if it is absent.
    anchored.current = anchorSeq

    const element = node.querySelector<HTMLElement>(`[data-seq="${anchorSeq}"]`)
    if (!element) return

    node.scrollTo({ top: element.offsetTop - 12 })
    const target = stream.state.items.find(
      (item) => item.kind === 'message' && item.seq === anchorSeq,
    )
    if (target) setFlashed(target.id)
  }, [anchorSeq, hasAnchor, stream.loading, stream.state.items, conversation, growWindowTo])

  /**
   * Position the thread on opening, then reveal it.
   *
   * Once per conversation after the initial view and any pages needed for the saved anchor
   * arrive. Until then, `placed` keeps the changing layout hidden.
   */
  useLayoutEffect(() => {
    const node = scroller.current
    // The conversation, not just its ID: the thread renders only after metadata arrives.
    // If folding finishes first, this effect has no node to measure and would not
    // rerun when the thread mounts.
    if (placed || stream.loading || !conversationId || !conversation || !node) return

    /**
     * Set the opening position, with `null` meaning bottom, then reveal.
     *
     * Derive bottom-following from the result rather than intent: an old position can end up at
     * the bottom of a barely grown thread; marking it detached would show a bottom arrow while
     * already there.
     */
    const settle = (top: number | null) => {
      if (top === null) scrollToBottom(node)
      else node.scrollTop = top
      // `onScroll` does not track position before placement: without this assignment,
      // the first reading gesture would be compared with another conversation's
      // position and fail to detach the thread.
      lastTop.current = node.scrollTop
      setStuckToBottom(node.scrollHeight - node.scrollTop - node.clientHeight < STICKY_THRESHOLD_PX)
      setPlaced(true)
    }

    // Search takes precedence: opening from a result must show that result, not a
    // previous reading position. The effect above positioned it; only derive
    // bottom-following and reveal it now.
    if (hasAnchor) {
      if (anchored.current === anchorSeq) settle(node.scrollTop)
      return
    }

    const saved = readThreadScroll(conversationId)
    if (saved.atBottom) {
      settle(null)
      return
    }

    // The remembered message may precede the window: bring it in, then resume
    // positioning on the next render while still hidden.
    if (growWindowTo(saved.seq)) return

    const element = node.querySelector<HTMLElement>(`[data-seq="${saved.seq}"]`)
    // No longer in the thread: compacted, forked or deleted. Bottom remains the right default.
    settle(element ? element.offsetTop - saved.offset : null)
  }, [placed, stream.loading, conversationId, conversation, hasAnchor, anchorSeq, growWindowTo])

  /**
   * Next or previous turn from the scroll position.
   *
   * Deliberately not from `visibleTurns`: after a jump, the preceding turn remains visible
   * because its region extends to the next message. Taking the first visible turn repeatedly
   * returned to the same place, preventing the next arrow from descending.
   *
   * Reread anchors on every call: they move as content grows, so cached positions would be
   * stale by the next turn.
   */
  const step = useCallback(
    (direction: -1 | 1) => {
      const node = scroller.current
      if (!node) return

      const anchors = [...turnAnchors.current.entries()]
        .map(([id, element]) => ({ id, top: element.offsetTop }))
        .sort((a, b) => a.top - b.top)

      // Tolerance: jumps land at `offsetTop - 12`, and smooth scrolling stops a few
      // pixels away. Without it, the just-reached turn appears “below” itself,
      // leaving the arrow stuck in place.
      const cursor = node.scrollTop + 16
      const target =
        direction === 1
          ? anchors.find((anchor) => anchor.top > cursor)
          : [...anchors].reverse().find((anchor) => anchor.top < cursor - 8)

      if (target) {
        jumpToTurn(target.id)
        return
      }

      // Nothing mounted above, but the thread continues before the window:
      // without this fallback, the arrow would stop at the first displayed turn
      // as if the conversation began there.
      if (direction === -1 && view.hidden > 0) {
        const first = anchors[0]
        const index = first ? turns.findIndex((turn) => turn.id === first.id) : turns.length
        const previous = turns[index - 1]
        if (previous) jumpToTurn(previous.id)
      }
    },
    [jumpToTurn, turns, view.hidden],
  )

  // Scroll before paint; otherwise every delta causes a visible jump.
  //
  // Do nothing before placement: this effect follows positioning in the same batch
  // with stale `stuckToBottom`, which would send the freshly restored reading
  // position back to the bottom.
  useLayoutEffect(() => {
    if (!placed || !stuckToBottom) return
    const node = scroller.current
    if (node) scrollToBottom(node)
  }, [stream.state.items, stream.state.lastSeq, stuckToBottom, placed])

  // Growing content moves turns: the ruler must follow even without
  // user scrolling.
  useEffect(syncVisibleTurns, [syncVisibleTurns, stream.state.items, stream.state.lastSeq])

  // Opening the keyboard shrinks the thread viewport: without realignment, the latest
  // message is hidden just when the user replies.
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const stick = () => {
      const node = scroller.current
      if (stuckToBottom && node) scrollToBottom(node)
    }
    viewport.addEventListener('resize', stick)
    return () => viewport.removeEventListener('resize', stick)
  }, [stuckToBottom])

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

  /**
   * Fork the conversation just before a message.
   *
   * Cut at `seq - 1`: retain everything before it and return the cut message to the composer
   * for rephrasing. That is the purpose of a fork; keeping it in history would defeat it.
   *
   * Stable across renders: passed directly to user bubbles, a recreated function breaks
   * memoization and redraws the whole thread on every scroll. Search highlights, which retain
   * ranges on those text nodes, were lost in the process.
   */
  const fork = useCallback(
    async (message: MessageItem) => {
      if (!conversationId) return

      setForkTarget(null)
      setForking(true)
      setActionError(null)
      try {
        const branch = await forkConversation(conversationId, message.seq - 1)
        void queryClient.invalidateQueries({ queryKey: ['conversations'] })
        const draft = message.blocks
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n\n')
        navigate(conversationPath(branch), { state: { draft } })
      } catch (err) {
        setActionError(err instanceof Error ? err.message : t('conversation.fork.error'))
      } finally {
        setForking(false)
      }
    },
    [conversationId, navigate, queryClient, t],
  )

  // Prepared continuations must show their context before the first message.
  const emptyThread = !stream.loading && stream.state.items.length === 0
  const handoff = useHandoff(conversationId, (metaOpen || emptyThread) && Boolean(conversation?.handoffFromId))

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

  const compact = async () => {
    setCompacting(true)
    setActionError(null)
    try {
      await compactConversation(conversationId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('conversation.compact.error'))
    } finally {
      setCompacting(false)
    }
  }

  /**
   * Commands Sillage executes itself, launched from the composer.
   *
   * Errors return to the input, restoring the command verbatim, rather than the page banner:
   * the action starts in the input and is retried there.
   */
  const runCommand = async (name: string) => {
    await flushConfig()
    if (name === 'compact') await compactConversation(conversationId)
  }

  const send = async (
    text: string,
    attachmentIds: string[],
    mentions: string[],
    skills: string[],
  ) => {
    // Desktop diagnostics split a slow send between settings and delivery: Windows reports of
    // seconds after Enter could not be located without it.
    const started = performance.now()
    await flushConfig()
    const configMs = performance.now() - started
    await sendMessage(conversationId, text, attachmentIds, mentions, skills)
    recordPerformance('send', { configMs, postMs: performance.now() - started - configMs })
    void queryClient.invalidateQueries({ queryKey: conversationsKey(conversation.projectId) })
  }

  const steer = async (
    text: string,
    attachmentIds: string[],
    mentions: string[],
    skills: string[],
  ) => {
    await flushConfig()
    await steerConversation(conversationId, text, attachmentIds, mentions, skills)
  }

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

        <header
          className={cx(
            'surface sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-1.5',
            'border-b border-line px-2 py-2 @min-[44rem]/thread:gap-3 @min-[44rem]/thread:px-4',
            // The show-navigation button occupies this corner: without reserved space,
            // it covers the CLI icon.
            sidebarHidden && !concentration && 'md:pl-14',
            concentration && 'sg-concentration-header',
          )}
        >
          {!concentration ? <MobileNavigationButton /> : null}
          <span
            role="img"
            aria-label={AGENT_LABELS[conversation.agent]}
            title={AGENT_LABELS[conversation.agent]}
            className="flex size-8 shrink-0 items-center justify-center"
          >
            <AgentIcon agent={conversation.agent} size={20} />
          </span>

          <div className="sg-conversation-heading min-w-0 flex-1">
            {/* Preserve project width; truncate the branch first. */}
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-ink-soft">
              {conversation.projectId ? <>
              <Link
                to={`/p/${conversation.projectId}`}
                className="max-w-[60%] shrink-0 truncate rounded-sm hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              >
                {project?.name}
              </Link>
              {!conversation.worktreeId ? <WorkspaceLabel
                worktreeId={conversation.worktreeId}
                worktree={worktree}
                worktreesLoaded={worktrees !== undefined}
                projectGit={project?.git}
                projectPath={project?.workspacePath}
              /> : null}
              {/*
               * The card sits with the project and branch: it names what the session is for.
               * Opening it in the panel keeps the thread in view, unlike leaving for the board.
               */}
              {conversation.card ? (
                <button
                  type="button"
                  onClick={showCard}
                  title={t('conversation.card.open', { number: conversation.card.number, title: conversation.card.title, column: columnLabel(conversation.card.column) })}
                  className="flex min-w-0 items-center gap-1 rounded-sm text-ink-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <SquareKanban size={12} className="shrink-0" />
                  <span className="shrink-0 font-medium">#{conversation.card.number}</span>
                  <span className="min-w-0 truncate">{conversation.card.title}</span>
                </button>
              ) : null}
              </> : <span>{t('discussions.personal')}</span>}
            </div>
            <p className="truncate text-sm font-medium" title={conversation.title}>{conversation.title}</p>


          </div>

          {/*
           * The header retains only states invalidating the current reading: errors,
           * interrupted turns or disconnected links. Everything else lives above the composer,
           * visible alongside the header; repeating it would duplicate it.
           */}
          <SignalRow signals={signals.filter((signal) => HEADER_SIGNALS.has(signal.kind))} />

          {/* Narrow threads keep full touch targets on a separate action row. */}
          <TooltipProvider delayDuration={120}>
            <div className="flex w-full shrink-0 items-center justify-start gap-0.5 overflow-x-auto @min-[56rem]/thread:justify-end @min-[56rem]/thread:w-auto" data-conversation-toolbar>
              <IconButton label={t('conversation.usage.title')} onClick={() => setUsageOpen(true)}>
                <GaugeCircle size={18} />
              </IconButton>
              <IconButton label={t(conversation.projectId ? 'conversation.instructions' : 'discussions.context')} onClick={() => setInstructionsOpen(true)}>
                <FileText size={18} />
              </IconButton>
              <IconButton label={t('conversation.search')} onClick={() => setFindOpen(true)}>
                <Search size={18} />
              </IconButton>
              {isOwner && AGENT_CAPABILITIES[conversation.agent].compact ? (
                <IconButton
                  label={compacting || stream.state.compacting
                    ? t('conversation.compact.running')
                    : t('conversation.compact.action')}
                  // Summarizing during a turn would discard context still being changed.
                  disabled={compacting || stream.state.compacting || stream.status !== 'idle'}
                  onClick={() => void compact()}
                >
                  <Shrink size={18} />
                </IconButton>
              ) : null}
              <IconButton label={t('conversation.meta.details')} onClick={() => setMetaOpen(true)}>
                <Info size={18} />
              </IconButton>
              {!conversation.projectId ? (
                <IconButton label={t('discussions.project.create')} onClick={() => setCreateProjectOpen(true)}>
                  <FolderPlus size={18} />
                </IconButton>
              ) : null}
              <IconButton label={t('conversation.handoff.menu')} onClick={() => setHandoffOpen(true)}>
                <ArrowRightLeft size={18} />
              </IconButton>
              {/*
               * Direct access to the card: with one, it toggles the panel's Card tab; without,
               * it attaches the session to one. Readers who cannot attach only see it with a card.
               */}
              {conversation.projectId && (conversation.card || isOwner) ? (
                <IconButton
                  label={conversation.card
                    ? t(cardShown ? 'conversation.card.hide' : 'conversation.card.show', { number: conversation.card.number })
                    : t('conversation.card.link')}
                  onClick={() => {
                    if (!conversation.card) setCardLinkOpen(true)
                    else if (cardShown) setPanelOpen(false)
                    else showCard()
                  }}
                >
                  <SquareKanban size={18} className={cx(cardShown && 'text-accent')} />
                </IconButton>
              ) : null}

              {/*
               * At the far right edge, where the panel opens. The panel belongs to the conversation
               * and reads this thread's working directory, including its worktree, not the
               * project's.
               */}
              {conversation.projectId ? <ActionsLauncher projectId={conversation.projectId} conversationId={conversationId} /> : null}
              <IconButton
                label={panel.open ? t('conversation.panel.close') : t('conversation.panel.open')}
                onClick={() => setPanelOpen(!panel.open)}
              >
                <PanelRight size={18} className={cx(panel.open && 'text-accent')} />
              </IconButton>
              <ConcentrationButton />
            </div>
          </TooltipProvider>
        </header>
        {!concentration && !conversation.projectId && allConversations?.some(entry => entry.handoffFromId === conversation.id && entry.projectId) ? <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2 text-xs text-ink-soft">
          <span>{t('discussions.project.linked')}</span>
          {allConversations.filter(entry => entry.handoffFromId === conversation.id && entry.projectId).map(entry => <Link key={entry.id} to={conversationPath(entry)} className="text-accent hover:underline">{entry.title}</Link>)}
        </div> : null}
        {!concentration ? <ConversationWorktreeBar key={conversation.id} conversation={conversation} canClean={project?.isOwner ?? false} /> : null}

        {conversation.projectId && isOwner ? (
          <CardLinkDialog
            conversation={{ ...conversation, projectId: conversation.projectId }}
            open={cardLinkOpen}
            onClose={() => setCardLinkOpen(false)}
            onLinked={showCard}
          />
        ) : null}
        <InstructionsDialog
          open={instructionsOpen}
          onOpenChange={setInstructionsOpen}
          projectId={conversation.projectId}
        />
        <Dialog.Root open={metaOpen} onOpenChange={setMetaOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
            <Dialog.Content
              aria-describedby={undefined}
              className="surface fixed top-1/2 left-1/2 z-50 max-h-[85dvh] w-[min(30rem,92vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-line p-4 shadow-pop"
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <Dialog.Title className="text-sm font-semibold">{t('conversation.meta.details')}</Dialog.Title>
                <Dialog.Close asChild>
                  <IconButton label={t('common.close')}><X size={18} /></IconButton>
                </Dialog.Close>
              </div>
              <p className="mb-3 break-words text-sm text-ink-soft">{conversation.title}</p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                <Meta title={AGENT_LABELS[conversation.agent]}>
                  {stream.state.model ?? AGENT_LABELS[conversation.agent]}
                </Meta>

                <Meta
                  icon={worktree ? <GitBranch size={10} /> : <FolderTree size={10} />}
                  title={
                    worktree
                      ? t('conversation.meta.worktree', { name: worktree.name })
                      : t('conversation.meta.projectFolder')
                  }
                >
                  {worktree ? worktree.name : t('conversation.meta.project')}
                </Meta>

                {/*
                 * Forks show their origin: otherwise two nearly identical sidebar threads
                 * cannot be distinguished. The link disappears if the original is deleted and
                 * the reference becomes orphaned.
                 */}
                {origin ? (
                  <Link
                    to={conversationPath(origin)}
                    className="flex shrink-0 items-center gap-1 rounded-full bg-surface-high px-1.5 py-0.5 hover:text-ink"
                    title={t('conversation.meta.branchOf', { title: origin.title })}
                  >
                    <GitBranch size={10} />
                    <span className="max-w-32 truncate">{origin.title}</span>
                  </Link>
                ) : null}

                {/*
                 * Continuations show their source thread and CLI, explaining why the agent
                 * knows work not visible in this thread.
                 */}
                {continued ? (
                  <Link
                    to={conversationPath(continued)}
                    className="flex shrink-0 items-center gap-1 rounded-full bg-surface-high px-1.5 py-0.5 hover:text-ink"
                    title={t('conversation.meta.continues', { title: continued.title, agent: AGENT_LABELS[continued.agent] })}
                  >
                    <AgentIcon agent={continued.agent} size={10} />
                    <span className="max-w-32 truncate">{continued.title}</span>
                  </Link>
                ) : null}

                {/*
                 * Route back to the work item: from a session to its card. Use the card title
                 * at load time, not a copy frozen at creation.
                 */}
                {conversation.card ? (
                  <Link
                    to={`/p/${conversation.projectId}/board?carte=${conversation.card.number}`}
                    className="flex shrink-0 items-center gap-1 rounded-full bg-surface-high px-1.5 py-0.5 hover:text-ink"
                    title={t('conversation.meta.card', { title: conversation.card.title })}
                  >
                    <SquareKanban size={10} />
                    <span>#{conversation.card.number}</span>
                  </Link>
                ) : null}

                {/*
                 * Explicitly identify API-launched conversations: users can write in them
                 * normally, but remote agents also control them. Discovering an unsolicited
                 * turn without knowing its origin is the worst way to learn this.
                 */}
                {/*
                 * Not `Meta`: it uses monospace and truncates at 10rem, cutting the sentence
                 * midway. The sentence must be readable in full to be useful.
                 */}
                {conversation.origin ? (
                  <span className="flex min-w-0 items-center gap-1 rounded-full bg-accent-wash px-1.5 py-0.5 text-accent">
                    <Terminal size={10} />
                    {t('conversation.meta.apiControlled', { label: conversation.origin.label })}
                  </span>
                ) : null}

                {/*
                 * What a continuation knows of its source: the exact received block, allowing
                 * users to check omissions before repeating them.
                 */}
                {handoff.data ? (
                  <details className="basis-full text-xs">
                    <summary className="cursor-pointer text-ink-soft">
                      {t('conversation.meta.handoff')} ·{' '}
                      {t('conversation.meta.handoffSize', {
                        kilobytes: Math.max(1, Math.round(handoff.data.bytes / 1000)),
                        budget: Math.round(handoff.data.budgetTokens / 1000),
                      })}
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-sunken p-2 text-[0.6875rem] whitespace-pre-wrap text-ink-soft">
                      {handoff.data.text}
                    </pre>
                  </details>
                ) : null}

                {/*
                 * Everything comes from the fold: the journal is the sole display source (I2)
                 * and alone carries cache-token details.
                 */}
                <UsageSummary
                  account={billingAccount}
                  rateLimit={stream.state.rateLimit}
                  costUsd={stream.state.costUsd}
                  inputTokens={stream.state.inputTokens}
                  outputTokens={stream.state.outputTokens}
                  cacheCreationTokens={stream.state.cacheCreationTokens}
                  cacheReadTokens={stream.state.cacheReadTokens}
                />
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <UsagePanel agent={conversation.agent} account={usageAccountOf(config)} open={usageOpen} onOpenChange={setUsageOpen} />

        <RestoreCheckpointDialog
          conversationId={conversationId}
          checkpoint={restoreTarget}
          openerText={restoreTarget?.openerText ?? ''}
          onClose={() => setRestoreTarget(null)}
        />

        <ConfirmDialog
          open={forkTarget !== null}
          onOpenChange={(next) => {
            if (!next) setForkTarget(null)
          }}
          title={t('conversation.fork.confirm.title')}
          confirmLabel={t('conversation.fork.confirm.action')}
          busy={forking}
          onConfirm={() => {
            if (forkTarget) void fork(forkTarget)
          }}
        >
          <p>
            {t('conversation.fork.confirm.before')} <em>{t('conversation.fork.confirm.emphasis')}</em>
            {t('conversation.fork.confirm.after')}
          </p>
          <p>{t('conversation.fork.confirm.unaffected')}</p>
        </ConfirmDialog>

        {createProjectOpen ? <CreateProjectDialog source={conversation} onOpenChange={setCreateProjectOpen} /> : null}
        {handoffOpen ? (
          <HandoffDialog open={handoffOpen} onOpenChange={setHandoffOpen} source={conversation} />
        ) : null}

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
            <div
              className={cx(
                'sg-conversation-content mx-auto flex sg-conversation-width flex-col gap-3 p-3 md:p-6 @min-[40rem]:px-12',
                placed ? 'opacity-100 transition-opacity duration-200' : 'opacity-0',
              )}
            >
              {stream.error ? <Banner>{stream.error}</Banner> : null}
              {actionError ? <Banner>{actionError}</Banner> : null}
    
              {emptyThread && conversation.handoffFromId ? (
                handoff.data ? <ContinuationIntro key={conversation.id} text={handoff.data.text} canStart={isOwner}
                  onStart={() => send(t('conversation.continuation.prompt'), [], [], [])} />
                  : handoff.error ? <Banner>{handoff.error.message}</Banner>
                    : <p className="text-sm text-ink-soft">{t('conversation.loading')}</p>
              ) : emptyThread ? (
                <EmptyState
                  title={t('conversation.empty.title')}
                  description={t('conversation.empty.description')}
                />
              ) : null}
    
              {view.hidden > 0 || stream.hasMore ? (
                <button
                  type="button"
                  onClick={showEarlier}
                  disabled={stream.loadingOlder}
                  className={cx(
                    'surface mx-auto rounded-full border border-line px-3 py-1.5',
                    'text-xs text-ink-soft transition-colors hover:text-ink',
                  )}
                >
                  {stream.loadingOlder ? t('journal.history.loading') : stream.hasMore ? t('journal.history.earlier') : t(
                    view.hidden > 1
                      ? 'conversation.thread.earlier.other'
                      : 'conversation.thread.earlier.one',
                    { count: view.hidden },
                  )}
                </button>
              ) : null}
    
              <ChatThread
                rows={view.rows}
                mayCollapseTools={concentration ? !findOpen : !placed || stuckToBottom}
                conversationId={conversationId}
                canDecide={isOwner}
                onFork={isOwner && !forking ? setForkTarget : undefined}
                flashedId={flashed}
                anchors={turnAnchors}
                checkpoints={stream.state.checkpoints}
                onShowChanges={(checkpoint) => showCheckpoint(checkpoint.key)}
                onRestoreCheckpoint={isOwner && !stream.state.turnRunning ? setRestoreTarget : undefined}
              />
    
              {activity && !concentration ? <TurnActivity label={activity} /> : null}
              {stream.state.turnRunning && !concentration ? <NewsTicker key={conversationId} /> : null}
    
              {/* Below the indicator: what the agent has not read yet. */}
              <QueuedMessages
                conversationId={conversationId}
                messages={stream.state.queued}
                canCancel={isOwner}
                canSteer={canSteer}
              />

              <HeldSessionMessages
                conversationId={conversationId}
                messages={stream.state.heldSessionMessages}
                canDecide={isOwner}
              />

              {/*
               * CLI-predicted next message while nothing is sent or queued: a queued message
               * already answers the turn.
               */}
              {stream.state.suggestion && !stream.state.turnRunning && stream.state.queued.length === 0 ? (
                <PromptSuggestion text={stream.state.suggestion} disabled={!isOwner} />
              ) : null}
            </div>
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
            <>
              <TooltipButton
                type="button"
                onClick={() => {
                  const node = scroller.current
                  if (node) scrollToBottom(node)
                  setStuckToBottom(true)
                }}
                className={cx(
                  'absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2',
                  'surface rounded-full border border-line p-2 text-ink-soft shadow-float',
                )}
                aria-label={t('conversation.scroll.bottom')}
              >
                <ArrowDown size={16} />
              </TooltipButton>

              <div className={cx("absolute right-3 bottom-full z-10 mb-2", concentration && "hidden")}>
                <TurnNav count={turns.length} onStep={step} />
              </div>
            </>
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
            context={stream.state.context}
            onSteer={canSteer ? steer : undefined}
            onSend={send}
            onCommand={runCommand}
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
            footer={
              <ComposerStatus
                agent={conversation.agent}
                connected={stream.connected}
                warm={stream.warm}
              />
            }
          />
        </div>
      </div>

      {/*
       * Mounted through the exit animation: `panel.open` is the target state; `panel.mounted`
       * controls document presence. No loading overlay: show the panel once its code loads
       * instead of flashing an empty column.
       */}
      {panel.mounted ? (
        <Suspense fallback={null}>
          <SidePanel
            projectId={conversation.projectId}
            conversationId={conversationId}
            workspaceName={conversation.worktreeId ? (worktree?.name ?? '…') : undefined}
            agent={conversation.agent}
            editTurns={stream.state.editTurns}
            history={{ hasMore: stream.hasMore, loading: stream.loadingOlder, load: loadOlder }}
            checkpoints={stream.state.checkpoints}
            canRestore={isOwner && !stream.state.turnRunning}
            turnRunning={stream.state.turnRunning}
            subAgents={subAgents}
            background={background}
            mcpServers={stream.state.mcp}
            cardId={conversation.card?.id ?? null}
            cardActions={isOwner ? {
              change: () => setCardLinkOpen(true),
              detach: () => setConversationCard.mutate({ id: conversation.id, cardId: null }),
              detaching: setConversationCard.isPending,
            } : undefined}
            open={panel.open}
            docked={panelLayout.docked}
            canDock={panelLayout.canDock}
          />
        </Suspense>
      ) : null}
    </div>
    </CardRefContext.Provider>
    </FileLinkContext.Provider>
  )
}

function Meta({
  icon,
  title,
  children,
}: {
  icon?: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <span
      title={title}
      className="flex shrink-0 items-center gap-1 rounded-full bg-surface-high px-1.5 py-0.5"
    >
      {icon}
      <span className="max-w-40 truncate font-mono">{children}</span>
    </span>
  )
}
