import { EventEmitter } from 'node:events'

/**
 * The daemon's own DevTools connection to a browser, separate from the agent's: Chromium accepts
 * several clients, so the live view and takeover never go through Playwright and never disturb it.
 * Flat sessions: page commands carry the `sessionId` of `Target.attachToTarget({ flatten: true })`.
 * Node's built-in WebSocket client (Node 22+), so `ws` need not become a direct dependency.
 */
export class CdpConnection extends EventEmitter {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  private constructor(private readonly socket: WebSocket) {
    super()
    socket.addEventListener('message', (event) => {
      let message: { id?: number; method?: string; params?: unknown; sessionId?: string; result?: unknown; error?: { message: string } }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id)
        if (!waiter) return
        this.pending.delete(message.id)
        if (message.error) waiter.reject(new Error(message.error.message))
        else waiter.resolve(message.result)
        return
      }
      if (message.method) this.emit('event', message.method, message.params ?? {}, message.sessionId ?? null)
    })
    socket.addEventListener('close', () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('DevTools connection closed'))
      this.pending.clear()
      this.emit('close')
    })
  }

  static open(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.addEventListener('open', () => resolve(new CdpConnection(socket)), { once: true })
      socket.addEventListener('error', () => reject(new Error(`Cannot reach the browser's DevTools at ${url}`)), { once: true })
    })
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string | null): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('DevTools connection closed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close(): void {
    this.socket.close()
  }
}
