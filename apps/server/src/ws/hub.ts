import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import {
  CATCHUP_THRESHOLD,
  HEARTBEAT_INTERVAL_MS,
  clientMessageSchema,
  type ServerMessage,
} from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'
import type { Notifications } from '../notifications/dispatcher.js'
import type { SessionManager, StatusBroadcast } from '../sessions/session-manager.js'
import type { AppContext } from '../http/context.js'
import { canReadConversation, readConversationState } from '../http/routes/conversations.js'
import { watchDirectory } from '../tree-watch.js'
import { conversationWorkspace, projectWorkspace, resolveInside } from '../workspace.js'

/** Routes whose success changes other tabs' sidebar contents. Sockets previously pushed only statuses, leaving deleted, renamed or archived sessions stale elsewhere until reload; new sessions appeared only because initial statuses exposed unknown IDs. `personal` notifies only the caller's tabs: bookmarks concern nobody else. Exclude read cursors, which advance every two seconds during turns and would trigger constant list reloads. Scheduler and webhook creations bypass routes; their first status reveals them. */
export const LIST_ROUTES: Record<string, 'shared' | 'personal'> = {
  'POST /api/projects/:id/conversations': 'shared',
  'POST /api/v1/projects/:id/tasks': 'shared',
  'POST /api/projects/:id/conversations/order': 'shared',
  'POST /api/projects/:id/claude-sessions/:sessionId/import': 'shared',
  'POST /api/conversations/:id/fork': 'shared',
  'PATCH /api/conversations/:id': 'shared',
  'DELETE /api/conversations/:id': 'shared',
  'PUT /api/conversations/:id/favorite': 'personal',
  'DELETE /api/conversations/:id/favorite': 'personal',
  'POST /api/projects': 'shared',
  'POST /api/projects/order': 'shared',
  'PATCH /api/projects/:id': 'shared',
  'DELETE /api/projects/:id': 'shared',
  'PUT /api/projects/:id/pin': 'personal',
  'DELETE /api/projects/:id/pin': 'personal',
  'POST /api/projects/:id/schedules': 'shared',
  'PATCH /api/schedules/:id': 'shared',
  'DELETE /api/schedules/:id': 'shared',
  'POST /api/schedules/:id/run': 'shared',
  'POST /api/schedules/:id/check/approve': 'shared',
  'POST /api/projects/:id/actions': 'shared',
  'PATCH /api/actions/:id': 'shared',
  'POST /api/actions/:id/approve': 'shared',
  'DELETE /api/actions/:id': 'shared',
  'PATCH /api/schedules/:id/webhook': 'shared',
  'POST /api/schedules/:id/webhook/rotate': 'shared',
  'POST /api/schedules/:id/webhook/replay': 'shared',
}

/** One socket per tab, multiplexed across conversations: sidebars track statuses while main views follow conversations. Sockets only broadcast persisted journals (invariant I1). Disconnects interrupt and lose nothing: clients resubscribe from their cursors. */
class Connection {
  private readonly subscriptions = new Map<string, () => void>()
  /** Per-conversation disk watches for this client's expanded directories. */
  private readonly treeWatches = new Map<string, Map<string, () => void>>()
  private alive = true

  constructor(
    private readonly socket: WebSocket,
    private readonly userId: string,
    private readonly ctx: AppContext,
    private readonly log: EventLog,
    private readonly sessions: SessionManager,
  ) {}

  send(message: ServerMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return
    this.socket.send(JSON.stringify(message))
  }

  subscribe(conversationId: string, afterSeq: number, bodies = false): void {
    if (!canReadConversation(this.ctx, conversationId, this.userId)) {
      this.send({ t: 'error', code: 'conversation_not_found', message: 'Conversation not found.' })
      return
    }

    this.unsubscribe(conversationId)

    // Catch up before subscribing: reread missed events from the database,
    // then switch to live streaming.
    const missed = bodies
      ? this.log.readWithBodies(conversationId, afterSeq, CATCHUP_THRESHOLD + 1)
      : this.log.read(conversationId, afterSeq, CATCHUP_THRESHOLD + 1)
    if (missed.length > CATCHUP_THRESHOLD) {
      // Too far behind for socket replay: clients reload through paginated REST routes.
      const last = missed[missed.length - 1]
      this.send({
        t: 'catchup',
        conversationId,
        fromSeq: afterSeq,
        toSeq: last ? last.seq : afterSeq,
      })
    } else {
      for (const entry of missed) {
        this.send({
          t: 'event',
          conversationId,
          seq: entry.seq,
          ts: entry.ts,
          event: entry.event,
        })
      }
    }

    // Status snapshots prevent clients subscribing after the last change from keeping
    // their initial stale state. Sidebars have no journal
    // from which to derive it themselves.
    this.sendStatus(conversationId)

    const unsubscribe = this.log.subscribe(conversationId, (entry) => {
      this.send({
        t: 'event',
        conversationId,
        seq: entry.seq,
        ts: entry.ts,
        event: bodies ? this.log.withBodies(entry).event : entry.event,
      })
    })
    this.subscriptions.set(conversationId, unsubscribe)
  }

  sendStatus(conversationId: string): void {
    const state = readConversationState(this.ctx, conversationId)
    if (!state) return
    this.send({
      t: 'status',
      conversationId,
      status: state.status,
      warm: this.sessions.isWarm(conversationId),
      background: this.sessions.backgroundCount(conversationId),
      loops: this.sessions.loopCount(conversationId),
      appliedConfig: this.sessions.appliedConfig(conversationId),
      lastNotableSeq: state.lastNotableSeq,
      metrics: state.metrics,
    })
  }

  /** Status of every live session this account can read when sockets open. Clients clear statuses on reconnect because pre-disconnect pushes no longer hold, falling back to REST lists. Those lists know nothing about in-process background work or loops; without snapshots, their badges disappear until another status change. Cold conversations have nothing beyond list information. */
  sendLiveStatuses(): void {
    for (const conversationId of this.sessions.warmConversationIds()) {
      if (canReadConversation(this.ctx, conversationId, this.userId)) this.sendStatus(conversationId)
    }
  }

  /** Whether this connection belongs to the account and follows this conversation. */
  watches(conversationId: string, userId: string): boolean {
    return this.userId === userId && this.subscriptions.has(conversationId)
  }

  /** Tab-reported visibility and device push subscription. False until first declaration: silent tabs count as absent and receive system notifications rather than nothing. */
  private visible = false
  private endpoint: string | null = null

  setPresence(visible: boolean, endpoint: string | null): void {
    this.visible = visible
    this.endpoint = endpoint
  }

  isVisibleFor(userId: string): boolean {
    return this.visible && this.userId === userId
  }

  visibleEndpoint(userId: string): string | null {
    return this.isVisibleFor(userId) ? this.endpoint : null
  }

  unsubscribe(conversationId: string): void {
    this.subscriptions.get(conversationId)?.()
    this.subscriptions.delete(conversationId)
  }

  /** Aligns conversation disk watches with declared directories. Independent of journal subscriptions: side panels browse conversations without running sessions. Recheck read access on every declaration like statuses rather than retain initial permissions. */
  watchTree(scope: 'conversation' | 'project', id: string, paths: string[]): void {
    // Both scopes share one map: conversation and project IDs cannot collide,
    // but keys still make the scope explicit.
    const key = `${scope}:${id}`
    const current = this.treeWatches.get(key) ?? new Map<string, () => void>()

    let cwd: string | null = null
    if (paths.length > 0) {
      try {
        cwd =
          scope === 'conversation'
            ? conversationWorkspace(this.ctx.db, id, this.userId)
            : projectWorkspace(this.ctx.db, id, this.userId)
      } catch {
        this.send({
          t: 'error',
          code: scope === 'conversation' ? 'conversation_not_found' : 'project_not_found',
          message: scope === 'conversation' ? 'Conversation not found.' : 'Project not found.',
        })
      }
    }

    const wanted = new Set(cwd === null ? [] : paths)

    for (const [path, stop] of current) {
      if (wanted.has(path)) continue
      stop()
      current.delete(path)
    }

    try {
      for (const path of wanted) {
        if (current.has(path) || cwd === null) continue
        const absolute = resolveInside(cwd, path)
        current.set(
          path,
          watchDirectory(absolute, () => this.send({ t: 'tree-changed', scope, id, path })),
        )
      }
    } catch {
      // `resolveInside` rejects paths outside working directories. Clients offer only
      // server-supplied paths, so reaching this branch signals a defect;
      // existing watches remain valid.
      this.send({
        t: 'error',
        code: 'path_outside_workspace',
        message: 'Path is outside the working directory.',
      })
    }

    if (current.size > 0) this.treeWatches.set(key, current)
    else this.treeWatches.delete(key)
  }

  /** Broadcast statuses for every readable conversation, not just subscribed ones: sidebars track unopened conversations whose running badges otherwise changed only on reload. Recheck access on each push instead of retaining subscription permissions: changes happen only a few times per turn, reads are local, and revoked sharing can never leave stale access. */
  notifyStatus(update: StatusBroadcast): void {
    if (
      !this.subscriptions.has(update.conversationId) &&
      !canReadConversation(this.ctx, update.conversationId, this.userId)
    ) {
      return
    }
    this.send({ t: 'status', ...update })
  }

  notifyTitle(conversationId: string, title: string): void {
    if (this.subscriptions.has(conversationId)) {
      this.send({ t: 'title', conversationId, title })
      return
    }
    // Other tabs have only sidebar rows retaining the provisional
    // title: they must reread the list.
    if (canReadConversation(this.ctx, conversationId, this.userId)) this.notifyListsChanged()
  }

  notifyListsChanged(): void {
    this.send({ t: 'lists-changed' })
  }

  belongsTo(userId: string): boolean {
    return this.userId === userId
  }

  markAlive(): void {
    this.alive = true
  }

  /** Returns false when nothing arrived since the previous heartbeat. Also sends a WebSocket ping so clients without application pings remain detectable. */
  checkAlive(): boolean {
    if (!this.alive) return false
    this.alive = false
    if (this.socket.readyState === this.socket.OPEN) this.socket.ping()
    return true
  }

  close(): void {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe()
    this.subscriptions.clear()
    for (const watches of this.treeWatches.values()) {
      for (const stop of watches.values()) stop()
    }
    this.treeWatches.clear()
  }

  /** Dead sockets left open by mobile sleep are terminated immediately. */
  terminate(): void {
    this.close()
    this.socket.terminate()
  }
}

export async function registerWebSocketHub(
  app: FastifyInstance,
  ctx: AppContext,
  log: EventLog,
  sessions: SessionManager,
  notifications: Notifications,
): Promise<void> {
  const { default: websocket } = await import('@fastify/websocket')
  await app.register(websocket)

  const connections = new Set<Connection>()

  // Only the hub knows visible tabs and their viewed conversations:
  // this determines whether to toast, push a system notification or do nothing.
  notifications.setPresence({
    visibleEndpoints: (userId) =>
      new Set([...connections].map((connection) => connection.visibleEndpoint(userId)).filter((endpoint): endpoint is string => endpoint !== null)),
    watchesVisibly: (conversationId, userId) =>
      [...connections].some((connection) => connection.isVisibleFor(userId) && connection.watches(conversationId, userId)),
    toast: (userId, notification) => {
      for (const connection of connections) {
        if (connection.isVisibleFor(userId)) connection.send({ t: 'notify', notification })
      }
    },
    decisionsChanged: (userId) => {
      for (const connection of connections) {
        if (connection.belongsTo(userId)) connection.send({ t: 'decisions-changed' })
      }
    },
  })
  sessions.setNotifier(notifications)

  sessions.statusBus.on('status', (update: StatusBroadcast) => {
    for (const connection of connections) connection.notifyStatus(update)
  })

  sessions.statusBus.on(
    'title',
    ({ conversationId, title }: { conversationId: string; title: string }) => {
      for (const connection of connections) connection.notifyTitle(conversationId, title)
    },
  )

  app.get('/api/ws', { websocket: true }, (socket, request) => {
    // The authentication hook already resolved the session from cookies.
    const user = request.user
    if (!user) {
      socket.close(4401, 'unauthorized')
      return
    }

    const connection = new Connection(socket, user.id, ctx, log, sessions)
    connections.add(connection)
    connection.sendLiveStatuses()

    socket.on('message', (raw: Buffer) => {
      let parsed
      try {
        parsed = clientMessageSchema.parse(JSON.parse(raw.toString()))
      } catch {
        connection.send({ t: 'error', code: 'bad_message', message: 'Unreadable message.' })
        return
      }

      connection.markAlive()
      switch (parsed.t) {
        case 'subscribe':
          connection.subscribe(parsed.conversationId, parsed.afterSeq, parsed.bodies === 1)
          return
        case 'unsubscribe':
          connection.unsubscribe(parsed.conversationId)
          return
        case 'watch-tree':
          connection.watchTree(parsed.scope, parsed.id, parsed.paths)
          return
        case 'ping':
          connection.send({ t: 'pong' })
          return
        case 'presence':
          connection.setPresence(parsed.visible, parsed.endpoint)
          return
      }
    })

    socket.on('pong', () => connection.markAlive())

    socket.on('close', () => {
      connection.close()
      connections.delete(connection)
    })
  })

  // Registered after routes but applied to all: Fastify assembles route hooks
  // at startup rather than declaration time.
  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode >= 400) return
    const reach = LIST_ROUTES[`${request.method} ${request.routeOptions.url}`]
    if (!reach) return
    const userId = request.user?.id
    for (const connection of connections) {
      if (reach === 'shared' || (userId !== undefined && connection.belongsTo(userId))) {
        connection.notifyListsChanged()
      }
    }
  })

  // Mobile sleep can kill sockets without cleanly closing server connections.
  // Heartbeats remove these instead of accumulating them.
  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      if (!connection.checkAlive()) {
        connection.terminate()
        connections.delete(connection)
      }
    }
  }, HEARTBEAT_INTERVAL_MS * 2)
  heartbeat.unref()

  app.addHook('onClose', async () => {
    clearInterval(heartbeat)
    for (const connection of connections) connection.close()
    connections.clear()
  })
}
