import {
  HEARTBEAT_INTERVAL_MS,
  MAX_WATCHED_PATHS,
  type AgentConfig,
  type ClientMessage,
  type ConversationMetrics,
  type ConversationStatus,
  type ServerMessage,
  type SillageEvent,
  type InAppNotification,
} from '@sillage/protocol'
import { decodeScope, projectScope, type WorkspaceScope } from './workspace-scope'

export interface StreamListener {
  onEvent(seq: number, ts: number, event: SillageEvent): void
  /**
   * `appliedConfig` is the configuration currently used by the CLI, or `null` before startup. It
   * differs from the saved configuration while a setting that cannot change live awaits a restart.
   * See the protocol's `status` message.
   */
  onStatus(status: ConversationStatus, warm: boolean, appliedConfig: AgentConfig | null): void
  /** Title suggested by the CLI after the first turn. */
  onTitle(title: string): void
  /** Socket lag is too large: reload through the REST route. */
  onCatchupNeeded(): void
  onConnectionChange(connected: boolean): void
}

/**
 * Track statuses for the entire browser tab independently of the open thread. The server pushes
 * statuses for all readable conversations; this subscriber receives them without subscribing to
 * every log, which would require event replay for a single dot.
 */
export interface StatusUpdate {
  conversationId: string
  status: ConversationStatus
  warm: boolean
  background: number
  loops: number
  /** Latest `seq` worth notifying about, used to derive unread state. */
  lastNotableSeq: number
  /** Volume readings for detailed sidebar mode. */
  metrics: ConversationMetrics
}

export interface StatusWatcher {
  onStatus(update: StatusUpdate): void
  /**
   * Socket restored after a disconnect. Transitions during the outage were not pushed to anyone:
   * reload displayed data from its source.
   */
  onResync(): void
  /** A project or conversation was added, removed, or edited elsewhere. */
  onListsChanged(): void
}

const MAX_BACKOFF_MS = 15_000

/**
 * Time allowed for a server pong after returning to the foreground. Keep it short: displayed
 * statuses may be stale during this time, while a false positive only costs a reconnect.
 */
const PROBE_TIMEOUT_MS = 3_000

/** After this delay, `resync` yields even without a socket: the server is unreachable. */
const RESYNC_TIMEOUT_MS = 5_000

/**
 * Tree levels mount in a cascade when expanded. Let it settle before declaring the full set instead
 * of sending one message per level.
 */
const TREE_WATCH_FLUSH_MS = 50

/**
 * Single WebSocket client for the browser tab. Contains no business state: the log remains the
 * source of truth (invariant I2). Its only responsibility is keeping a cursor per conversation and
 * resubscribing from that cursor after a disconnect so nothing is lost or received twice.
 */
class WsClient {
  private socket: WebSocket | null = null
  private readonly listeners = new Map<string, Set<StreamListener>>()
  private readonly cursors = new Map<string, number>()
  private readonly statusWatchers = new Set<StatusWatcher>()
  /** Server-pushed toasts for this browser tab while visible. */
  private readonly notifyListeners = new Set<(notification: InAppNotification) => void>()
  private readonly decisionListeners = new Set<() => void>()
  /** This device's push subscription, sent to the server with visibility state. */
  private pushEndpoint: string | null = null
  /**
   * Watched disk directories, reference-counted per conversation. The same path can be requested
   * twice by panels on the same conversation or React strict-mode double mounting; the first
   * unsubscribe must not remove the other's watch.
   */
  private readonly treePaths = new Map<WorkspaceScope, Map<string, number>>()
  private readonly treeListeners = new Set<(scope: WorkspaceScope, path: string) => void>()
  private treeFlushTimer: number | null = null
  private reconnectAttempts = 0
  private reconnectTimer: number | null = null
  private heartbeatTimer: number | null = null
  private lastBeatAt = 0
  /**
   * Count all messages received since load: each proves socket liveness. Use a counter rather than
   * a timestamp so a reply arriving in the same millisecond as a ping is not mistaken for silence.
   */
  private received = 0
  private probeTimer: number | null = null
  private probeDeadline = 0
  private readonly openWaiters = new Set<() => void>()
  private disposed = false
  /** Distinguish first connection from reconnection, which alone requires resynchronization. */
  private opened = false

  constructor() {
    // A socket killed by phone sleep may never emit 'close': it claims to be open but receives
    // nothing, including statuses. Test it on every foreground return rather than reconnecting only
    // explicitly closed sockets. `resume` is Chrome Android thawing a tab; `pageshow` restores a
    // page from browser cache.
    const wake = () => this.check()
    window.addEventListener('online', wake)
    window.addEventListener('pageshow', wake)
    document.addEventListener('resume', wake)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') wake()
      this.sendPresence()
    })
    window.addEventListener('pagehide', () => this.sendPresence(false))
    // The device subscription, if any, lets the server avoid pushing a system notification while
    // the app is visible.
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker
        .getRegistration()
        .then((registration) => registration?.pushManager?.getSubscription())
        .then((subscription) => this.setPushEndpoint(subscription?.endpoint ?? null))
        .catch(() => {})
    }
  }

  /** After this device subscribes or unsubscribes. */
  setPushEndpoint(endpoint: string | null): void {
    this.pushEndpoint = endpoint
    this.sendPresence()
  }

  /** Visibility and device subscription provide enough information to choose between toast and notification. */
  private sendPresence(visible = document.visibilityState === 'visible'): void {
    if (this.isOpen) this.send({ t: 'presence', visible, endpoint: this.pushEndpoint })
  }

  onNotify(listener: (notification: InAppNotification) => void): () => void {
    this.notifyListeners.add(listener)
    return () => this.notifyListeners.delete(listener)
  }

  onDecisionsChanged(listener: () => void): () => void {
    this.decisionListeners.add(listener)
    return () => this.decisionListeners.delete(listener)
  }

  private get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  /** No subscribers remain: there is no need to keep or reconnect the socket. */
  private get idle(): boolean {
    return this.listeners.size === 0 && this.statusWatchers.size === 0 && this.treePaths.size === 0
  }

  private send(message: ClientMessage): void {
    if (this.isOpen) this.socket?.send(JSON.stringify(message))
  }

  subscribe(conversationId: string, afterSeq: number, listener: StreamListener): () => void {
    const existing = this.listeners.get(conversationId)
    const set = existing ?? new Set<StreamListener>()
    if (!existing) this.listeners.set(conversationId, set)
    set.add(listener)

    // The cursor never moves backward: a second subscriber with an older cursor must not trigger
    // replay for others.
    const current = this.cursors.get(conversationId) ?? -1
    if (afterSeq > current) this.cursors.set(conversationId, afterSeq)

    this.connect()
    if (this.isOpen) {
      this.send({ t: 'subscribe', bodies: 1, conversationId, afterSeq: this.cursors.get(conversationId) ?? 0 })
    }
    listener.onConnectionChange(this.isOpen)

    return () => {
      set.delete(listener)
      if (set.size === 0) {
        this.listeners.delete(conversationId)
        this.cursors.delete(conversationId)
        this.send({ t: 'unsubscribe', conversationId })
      }
    }
  }

  /**
   * Track statuses for all readable conversations without subscribing to a thread. This alone opens
   * the socket: the sidebar remains visible on pages without an open conversation and must stay
   * current there too.
   */
  watchStatuses(watcher: StatusWatcher): () => void {
    this.statusWatchers.add(watcher)
    this.connect()
    return () => {
      this.statusWatchers.delete(watcher)
    }
  }

  /**
   * Watch this directory on disk while the caller displays it. The server watches only paths
   * declared here: one watch per expanded directory, with no recursion. See server-side
   * `tree-watch.ts`.
   */
  watchTree(scope: WorkspaceScope, path: string): () => void {
    const paths = this.treePaths.get(scope) ?? new Map<string, number>()
    if (!this.treePaths.has(scope)) this.treePaths.set(scope, paths)
    paths.set(path, (paths.get(path) ?? 0) + 1)

    this.connect()
    this.scheduleTreeFlush()

    return () => {
      const held = this.treePaths.get(scope)
      const count = held?.get(path)
      if (!held || count === undefined) return

      if (count > 1) held.set(path, count - 1)
      else held.delete(path)
      // Keep the scope registered with an empty set so the message releasing its last server watches is sent.
      this.scheduleTreeFlush()
    }
  }

  /** Notify when a watched directory changes on disk. */
  onTreeChanged(listener: (scope: WorkspaceScope, path: string) => void): () => void {
    this.treeListeners.add(listener)
    return () => {
      this.treeListeners.delete(listener)
    }
  }

  private scheduleTreeFlush(): void {
    if (this.treeFlushTimer !== null) return
    this.treeFlushTimer = window.setTimeout(() => {
      this.treeFlushTimer = null
      this.sendTreeWatches()
    }, TREE_WATCH_FLUSH_MS)
  }

  private sendTreeWatches(): void {
    for (const [scope, paths] of this.treePaths) {
      // Truncate here as well as enforcing a server limit: beyond the limit the entire message
      // would be rejected, losing every tree watch rather than just extras. An explorer expanded
      // this far falls back to turn-end refresh and the refresh button.
      const watched = [...paths.keys()].slice(0, MAX_WATCHED_PATHS)
      const { kind, id } = decodeScope(scope)
      this.send({ t: 'watch-tree', scope: kind, id, paths: watched })
      if (paths.size === 0) this.treePaths.delete(scope)
    }
  }

  /** Reconnect a closed socket and test one claiming to be open. */
  check(): void {
    if (this.idle) return
    if (this.isOpen) this.probe(PROBE_TIMEOUT_MS)
    else this.reconnectNow()
  }

  /**
   * Start from a fresh socket as after a disconnect: threads catch up using cursors; statuses are
   * cleared and reread. Resolves on connection or after `RESYNC_TIMEOUT_MS` if the server does not
   * respond.
   */
  resync(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.openWaiters.delete(done)
        resolve()
      }
      const timer = window.setTimeout(done, RESYNC_TIMEOUT_MS)
      this.openWaiters.add(done)
      this.recycle()
    })
  }

  /** Current cursor, used to realign after a REST reload. */
  setCursor(conversationId: string, seq: number): void {
    const current = this.cursors.get(conversationId) ?? -1
    if (seq > current) this.cursors.set(conversationId, seq)
  }

  private connect(): void {
    if (this.disposed || this.socket) return

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${location.host}/api/ws`)
    this.socket = socket

    socket.onopen = () => {
      this.reconnectAttempts = 0
      for (const [conversationId, afterSeq] of this.cursors) {
        this.send({ t: 'subscribe', bodies: 1, conversationId, afterSeq })
      }
      // The server released watches from the lost connection: redeclare all of them using the
      // client's live set as the reference.
      this.sendTreeWatches()
      this.sendPresence()
      // Threads catch up using cursors; statuses have no backing log and must be reread separately.
      if (this.opened) {
        for (const watcher of this.statusWatchers) watcher.onResync()
      }
      this.opened = true
      this.broadcastConnection(true)
      this.startHeartbeat()
      for (const waiter of [...this.openWaiters]) waiter()
    }

    socket.onmessage = (raw) => {
      this.received += 1
      const message = JSON.parse(raw.data as string) as ServerMessage
      this.dispatch(message)
    }

    socket.onclose = () => {
      this.socket = null
      this.stopHeartbeat()
      this.broadcastConnection(false)
      this.scheduleReconnect()
    }

    // 'error' is always followed by 'close', which already handles reconnection.
    socket.onerror = () => socket.close()
  }

  private dispatch(message: ServerMessage): void {
    if (message.t === 'pong') return

    if (message.t === 'error') {
      console.warn('[sillage] websocket:', message.code, message.message)
      return
    }

    // Before subscriber filtering: the explorer watches a conversation without a thread log
    // subscription, since the panel is readable before a session starts.
    if (message.t === 'tree-changed') {
      const scope = message.scope === 'project' ? projectScope(message.id) : message.id
      for (const listener of this.treeListeners) listener(scope, message.path)
      return
    }

    if (message.t === 'lists-changed') {
      for (const watcher of this.statusWatchers) watcher.onListsChanged()
      return
    }

    if (message.t === 'notify') {
      for (const listener of this.notifyListeners) listener(message.notification)
      return
    }

    if (message.t === 'decisions-changed') {
      for (const listener of this.decisionListeners) listener()
      return
    }

    if (message.t === 'status') {
      const update: StatusUpdate = {
        conversationId: message.conversationId,
        status: message.status,
        warm: message.warm,
        background: message.background,
        loops: message.loops,
        lastNotableSeq: message.lastNotableSeq,
        metrics: message.metrics,
      }
      for (const watcher of this.statusWatchers) watcher.onStatus(update)
    }

    const listeners = this.listeners.get(message.conversationId)
    if (!listeners) return

    switch (message.t) {
      case 'event': {
        this.setCursor(message.conversationId, message.seq)
        for (const listener of listeners) {
          listener.onEvent(message.seq, message.ts, message.event)
        }
        return
      }
      case 'status': {
        // Use `?? null` rather than the raw field: older servers omit it, and the web app can be
        // deployed ahead of them without restarting the server.
        for (const listener of listeners) {
          listener.onStatus(message.status, message.warm, message.appliedConfig ?? null)
        }
        return
      }
      case 'title': {
        for (const listener of listeners) listener.onTitle(message.title)
        return
      }
      case 'catchup': {
        for (const listener of listeners) listener.onCatchupNeeded()
        return
      }
    }
  }

  private broadcastConnection(connected: boolean): void {
    for (const listeners of this.listeners.values()) {
      for (const listener of listeners) listener.onConnectionChange(connected)
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null || this.idle) return

    const delay = Math.min(2 ** this.reconnectAttempts * 500, MAX_BACKOFF_MS)
    this.reconnectAttempts += 1
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private reconnectNow(): void {
    if (this.isOpen || this.idle) return
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempts = 0
    this.connect()
  }

  /**
   * Discard the current socket and open a fresh one. `close()` alone is insufficient: on a dead
   * connection it waits for a reply that never arrives, delaying 'close' by tens of seconds. Detach
   * the socket before closing it, then follow the normal disconnect path.
   */
  private recycle(): void {
    const socket = this.socket
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      socket.close()
      this.socket = null
      this.stopHeartbeat()
      this.broadcastConnection(false)
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempts = 0
    if (!this.idle) this.connect()
  }

  /**
   * Send a ping and consider the socket dead if nothing returns within the deadline. Count received
   * messages rather than trusting timer punctuality: browsers delay background timers, sometimes by
   * a minute, and a response may have arrived long before the timer fires. Keep an existing earlier
   * deadline so a regular heartbeat cannot postpone a foreground liveness verdict.
   */
  private probe(timeoutMs: number): void {
    const before = this.received
    const deadline = Date.now() + timeoutMs
    this.send({ t: 'ping' })
    if (this.probeTimer !== null && this.probeDeadline <= deadline) return

    this.clearProbe()
    this.probeDeadline = deadline
    this.probeTimer = window.setTimeout(() => {
      this.probeTimer = null
      if (this.received === before && this.isOpen) this.recycle()
    }, timeoutMs)
  }

  private clearProbe(): void {
    if (this.probeTimer !== null) {
      clearTimeout(this.probeTimer)
      this.probeTimer = null
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.lastBeatAt = Date.now()
    this.heartbeatTimer = window.setInterval(() => {
      // A very late heartbeat indicates machine sleep, which `visibilitychange` misses if the tab
      // stayed foregrounded, such as closing and reopening a laptop. Reach a verdict quickly as on
      // phone resume instead of waiting for the next heartbeat.
      const late = Date.now() - this.lastBeatAt > HEARTBEAT_INTERVAL_MS * 2
      this.lastBeatAt = Date.now()
      this.probe(late ? PROBE_TIMEOUT_MS : HEARTBEAT_INTERVAL_MS)
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.clearProbe()
  }
}

export const wsClient = new WsClient()
