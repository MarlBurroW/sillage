import {
  HEARTBEAT_INTERVAL_MS,
  type AgentConfig,
  type ClientMessage,
  type ConversationMetrics,
  type ConversationStatus,
  type ServerMessage,
  type SillageEvent,
} from '@sillage/protocol'

export interface StreamListener {
  onEvent(seq: number, ts: number, event: SillageEvent): void
  /**
   * `appliedConfig` est la configuration sous laquelle le CLI tourne, `null` à froid.
   * Elle diverge de celle enregistrée tant qu'un réglage inapplicable en vol attend son
   * redémarrage. Voir le message `status` du protocole.
   */
  onStatus(status: ConversationStatus, warm: boolean, appliedConfig: AgentConfig | null): void
  /** Titre proposé par le CLI après le premier tour. */
  onTitle(title: string): void
  /** Retard trop important pour le socket : recharger par la route REST. */
  onCatchupNeeded(): void
  onConnectionChange(connected: boolean): void
}

/**
 * Suivi des statuts de l'onglet entier, indépendant du fil ouvert.
 *
 * Le serveur pousse le statut de toutes les conversations lisibles ; cet abonné les
 * reçoit sans avoir à s'abonner au journal de chacune, ce qui coûterait un rejeu
 * d'événements pour une seule pastille.
 */
export interface StatusUpdate {
  conversationId: string
  status: ConversationStatus
  warm: boolean
  background: number
  loops: number
  /** Dernier `seq` qui valait qu'on prévienne, d'où se déduit ce qui reste à lire. */
  lastNotableSeq: number
  /** Relevés de volume, pour le mode détaillé de la sidebar. */
  metrics: ConversationMetrics
}

export interface StatusWatcher {
  onStatus(update: StatusUpdate): void
  /**
   * Socket rétabli après une coupure. Les transitions survenues pendant celle-ci n'ont
   * été poussées à personne : ce qui est affiché doit être relu à la source.
   */
  onResync(): void
}

const MAX_BACKOFF_MS = 15_000

/**
 * Client WebSocket unique de l'onglet.
 *
 * Il ne porte aucun état métier : le journal reste la source de vérité (invariant I2).
 * Sa seule responsabilité est de garder un curseur par conversation et de se
 * réabonner à partir de ce curseur après une coupure, pour que rien ne soit perdu ni
 * reçu deux fois.
 */
class WsClient {
  private socket: WebSocket | null = null
  private readonly listeners = new Map<string, Set<StreamListener>>()
  private readonly cursors = new Map<string, number>()
  private readonly statusWatchers = new Set<StatusWatcher>()
  private reconnectAttempts = 0
  private reconnectTimer: number | null = null
  private heartbeatTimer: number | null = null
  private disposed = false
  /** Distingue la première ouverture d'une reprise, seule à devoir resynchroniser. */
  private opened = false

  constructor() {
    // Un socket tué par la mise en veille du téléphone ne déclenche pas toujours
    // 'close'. Ces deux signaux sont ce qui rend la reprise instantanée sur mobile.
    window.addEventListener('online', () => this.reconnectNow())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.reconnectNow()
    })
  }

  private get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  /** Plus personne n'attend rien : inutile de tenir ou de rétablir le socket. */
  private get idle(): boolean {
    return this.listeners.size === 0 && this.statusWatchers.size === 0
  }

  private send(message: ClientMessage): void {
    if (this.isOpen) this.socket?.send(JSON.stringify(message))
  }

  subscribe(conversationId: string, afterSeq: number, listener: StreamListener): () => void {
    const existing = this.listeners.get(conversationId)
    const set = existing ?? new Set<StreamListener>()
    if (!existing) this.listeners.set(conversationId, set)
    set.add(listener)

    // Le curseur ne recule jamais : un second abonné arrivant avec un curseur plus
    // ancien ne doit pas provoquer un rejeu pour les autres.
    const current = this.cursors.get(conversationId) ?? -1
    if (afterSeq > current) this.cursors.set(conversationId, afterSeq)

    this.connect()
    if (this.isOpen) {
      this.send({ t: 'subscribe', conversationId, afterSeq: this.cursors.get(conversationId) ?? 0 })
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
   * Suit les statuts de toutes les conversations lisibles, sans abonnement à un fil.
   *
   * Ouvre le socket à lui seul : la sidebar est visible sur des pages où aucune
   * conversation n'est ouverte, et devait pourtant y rester à jour.
   */
  watchStatuses(watcher: StatusWatcher): () => void {
    this.statusWatchers.add(watcher)
    this.connect()
    return () => {
      this.statusWatchers.delete(watcher)
    }
  }

  /** Curseur courant, utilisé après un rechargement REST pour se réaligner. */
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
        this.send({ t: 'subscribe', conversationId, afterSeq })
      }
      // Les fils rattrapent leur retard par leur curseur ; les statuts n'ont pas de
      // journal derrière eux et doivent être relus autrement.
      if (this.opened) {
        for (const watcher of this.statusWatchers) watcher.onResync()
      }
      this.opened = true
      this.broadcastConnection(true)
      this.startHeartbeat()
    }

    socket.onmessage = (raw) => {
      const message = JSON.parse(raw.data as string) as ServerMessage
      this.dispatch(message)
    }

    socket.onclose = () => {
      this.socket = null
      this.stopHeartbeat()
      this.broadcastConnection(false)
      this.scheduleReconnect()
    }

    // 'error' est toujours suivi de 'close', qui porte déjà la reconnexion.
    socket.onerror = () => socket.close()
  }

  private dispatch(message: ServerMessage): void {
    if (message.t === 'pong') return

    if (message.t === 'error') {
      console.warn('[sillage] websocket:', message.code, message.message)
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
        // `?? null` et non le champ brut : un serveur d'avant ce champ ne l'envoie pas,
        // et le web se déploie sans redémarrage, donc devant lui pendant un moment.
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

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = window.setInterval(() => this.send({ t: 'ping' }), HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}

export const wsClient = new WsClient()
