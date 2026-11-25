import type { FastifyInstance } from 'fastify'
import type { WebSocket as ServerSocket } from 'ws'
import { browserClientMessageSchema, type BrowserListDto, type BrowserServerMessage, type BrowserStatusDto } from '@sillage/protocol'
import type { AppContext } from '../http/context.js'
import { notFound } from '../http/errors.js'
import { requireAdmin, requireUser } from '../http/require-user.js'
import { canReadConversation } from '../http/routes/conversations.js'
import { BROWSER_CDP_PREFIX, type BrowserManager } from './manager.js'

export function registerBrowserRoutes(app: FastifyInstance, ctx: AppContext, browsers: BrowserManager): void {
  app.get('/api/browser/status', async (request): Promise<BrowserStatusDto> => {
    requireUser(request)
    return browsers.install.status()
  })

  /** Answers at once; the status reports progress and the outcome. */
  app.post('/api/browser/install', async (request, reply): Promise<BrowserStatusDto> => {
    requireAdmin(request)
    // Failures are kept in the status the screen polls.
    browsers.install.install().catch(() => {})
    reply.status(202)
    return browsers.install.status()
  })

  app.get('/api/browsers', async (request): Promise<BrowserListDto> => {
    const user = requireUser(request)
    return { browsers: (await browsers.list()).filter((browser) => canReadConversation(ctx, browser.conversationId, user.id)) }
  })

  app.delete<{ Params: { id: string } }>('/api/conversations/:id/browser', async (request, reply) => {
    const user = requireUser(request)
    if (!canReadConversation(ctx, request.params.id, user.id)) throw notFound('conversation_not_found', 'Conversation not found.')
    await browsers.close(request.params.id)
    return reply.status(204).send()
  })

  /** Live view and takeover. Anyone who can read the conversation may watch and act, like its terminals. */
  app.get<{ Params: { id: string } }>('/api/conversations/:id/browser/live', { websocket: true }, (socket: ServerSocket, request) => {
    const user = request.user
    if (!user || !canReadConversation(ctx, request.params.id, user.id)) {
      socket.close(4404, 'not_found')
      return
    }
    const send = (message: BrowserServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
    }
    const viewer = browsers.addViewer(request.params.id, send)
    socket.on('message', (raw: Buffer) => {
      let parsed
      try {
        parsed = browserClientMessageSchema.parse(JSON.parse(raw.toString()))
      } catch {
        send({ t: 'error', code: 'bad_message', message: 'Unreadable message.' })
        return
      }
      viewer.handle(parsed).catch(() => {})
    })
    socket.on('close', viewer.detach)
  })

  /**
   * The agent's DevTools endpoint: Playwright MCP connects here, and the daemon pipes it to the
   * conversation's Chromium, launching it on first use. Authenticated by the per-conversation token
   * in the URL (the MCP server runs without a browser session), exempted from the cookie check in
   * `app.ts`.
   */
  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(`${BROWSER_CDP_PREFIX}:id`, { websocket: true }, (socket: ServerSocket, request) => {
    const conversationId = request.params.id
    if (!browsers.verify(conversationId, request.query.token ?? '')) {
      socket.close(4401, 'unauthorized')
      return
    }
    // Messages sent before the browser is up wait here instead of being lost.
    const queued: string[] = []
    let upstream: WebSocket | null = null
    let closed = false
    socket.on('message', (raw: Buffer) => {
      const text = raw.toString()
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(text)
      else queued.push(text)
    })
    socket.on('close', () => {
      closed = true
      upstream?.close()
    })
    browsers.agentEndpoint(conversationId).then((endpoint) => {
      if (closed) return
      const remote = new WebSocket(endpoint)
      upstream = remote
      remote.addEventListener('open', () => {
        browsers.agentConnected(conversationId, true)
        for (const text of queued.splice(0)) remote.send(text)
      })
      remote.addEventListener('message', (event) => {
        if (socket.readyState === socket.OPEN) socket.send(String(event.data))
      })
      remote.addEventListener('close', () => {
        browsers.agentConnected(conversationId, false)
        socket.close()
      })
      remote.addEventListener('error', () => socket.close(1011, 'browser_unreachable'))
    }).catch((err: unknown) => {
      // The reason reaches Playwright's error, so the agent can relay it.
      const reason = err instanceof Error ? err.message : String(err)
      socket.close(1011, reason.slice(0, 120))
    })
  })
}
