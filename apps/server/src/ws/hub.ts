import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import {
  CATCHUP_THRESHOLD,
  HEARTBEAT_INTERVAL_MS,
  clientMessageSchema,
  type ServerMessage,
} from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'
import type { PushService } from '../push/push-service.js'
import type { SessionManager, StatusBroadcast } from '../sessions/session-manager.js'
import type { AppContext } from '../http/context.js'
import { canReadConversation, readConversationState } from '../http/routes/conversations.js'

/**
 * Un socket par onglet, multiplexé sur plusieurs conversations : la sidebar suit les
 * statuts pendant que la vue principale suit un fil.
 *
 * Le socket ne fait que diffuser un journal déjà persisté (invariant I1). Sa chute
 * n'interrompt rien et ne perd rien : le client se réabonne avec son curseur.
 */
class Connection {
  private readonly subscriptions = new Map<string, () => void>()
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

  subscribe(conversationId: string, afterSeq: number): void {
    if (!canReadConversation(this.ctx, conversationId, this.userId)) {
      this.send({ t: 'error', code: 'conversation_not_found', message: 'Conversation not found.' })
      return
    }

    this.unsubscribe(conversationId)

    // Rattrapage avant abonnement : les événements produits pendant la coupure sont
    // relus depuis la base, puis le flux temps réel prend le relais.
    const missed = this.log.read(conversationId, afterSeq, CATCHUP_THRESHOLD + 1)
    if (missed.length > CATCHUP_THRESHOLD) {
      // Trop de retard pour le socket : le client rechargera par la route REST paginée.
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

    // Instantané de statut : sans lui, un client qui s'abonne après le dernier
    // changement resterait sur l'état qu'il avait au chargement. La sidebar n'a pas
    // de journal à replier, elle ne peut pas le déduire elle-même.
    const state = readConversationState(this.ctx, conversationId)
    if (state) {
      this.send({
        t: 'status',
        conversationId,
        status: state.status,
        warm: this.sessions.isWarm(conversationId),
        background: this.sessions.backgroundCount(conversationId),
        loops: this.sessions.loopCount(conversationId),
        appliedConfig: this.sessions.appliedConfig(conversationId),
        lastSeq: state.lastSeq,
        metrics: state.metrics,
      })
    }

    const unsubscribe = this.log.subscribe(conversationId, (entry) => {
      this.send({
        t: 'event',
        conversationId,
        seq: entry.seq,
        ts: entry.ts,
        event: entry.event,
      })
    })
    this.subscriptions.set(conversationId, unsubscribe)
  }

  /** Vrai si cette connexion appartient au compte et suit cette conversation. */
  watches(conversationId: string, userId: string): boolean {
    return this.userId === userId && this.subscriptions.has(conversationId)
  }

  unsubscribe(conversationId: string): void {
    this.subscriptions.get(conversationId)?.()
    this.subscriptions.delete(conversationId)
  }

  /**
   * Le statut part pour toute conversation lisible, pas seulement pour le fil abonné :
   * la sidebar suit des lignes qu'elle n'a pas ouvertes, et sans ça leur point « en
   * cours » ne bougeait qu'au rechargement de la page.
   *
   * Le contrôle d'accès est refait à chaque poussée plutôt que porté par un abonnement :
   * les changements de statut se comptent en quelques-uns par tour, la lecture est
   * locale, et rien ne peut alors dériver d'un partage révoqué entre-temps.
   */
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
    if (!this.subscriptions.has(conversationId)) return
    this.send({ t: 'title', conversationId, title })
  }

  markAlive(): void {
    this.alive = true
  }

  /**
   * Retourne false si rien n'est arrivé depuis le battement précédent. Un ping WebSocket
   * est envoyé au passage : un client qui n'émet pas de ping applicatif reste détecté.
   */
  checkAlive(): boolean {
    if (!this.alive) return false
    this.alive = false
    if (this.socket.readyState === this.socket.OPEN) this.socket.ping()
    return true
  }

  close(): void {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe()
    this.subscriptions.clear()
  }

  /** Socket mort et non refermé (mise en veille mobile) : on coupe sans attendre. */
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
  push: PushService,
): Promise<void> {
  const { default: websocket } = await import('@fastify/websocket')
  await app.register(websocket)

  const connections = new Set<Connection>()

  // Un onglet abonné à un fil le voit déjà en direct : le notifier en plus reviendrait
  // à le prévenir de ce qu'il est en train de lire.
  sessions.setNotifier({
    isWatched: (conversationId, userId) =>
      [...connections].some((connection) => connection.watches(conversationId, userId)),
    notify: (userId, payload) => push.notify(userId, payload),
  })

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
    // Le hook d'authentification a déjà résolu la session à partir du cookie.
    const user = request.user
    if (!user) {
      socket.close(4401, 'unauthorized')
      return
    }

    const connection = new Connection(socket, user.id, ctx, log, sessions)
    connections.add(connection)

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
          connection.subscribe(parsed.conversationId, parsed.afterSeq)
          return
        case 'unsubscribe':
          connection.unsubscribe(parsed.conversationId)
          return
        case 'ping':
          connection.send({ t: 'pong' })
          return
      }
    })

    socket.on('pong', () => connection.markAlive())

    socket.on('close', () => {
      connection.close()
      connections.delete(connection)
    })
  })

  // Sur mobile, un socket tué par la mise en veille reste ouvert côté serveur sans
  // jamais se fermer proprement. Le battement les élimine au lieu de les accumuler.
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
