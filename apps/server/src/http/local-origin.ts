import type { FastifyInstance } from 'fastify'
import { HttpError } from './errors.js'

/**
 * Restricts a desktop instance to the application window.
 *
 * The server listens on 127.0.0.1, reachable by any page open in a browser on the
 * machine. Ports do not affect a cookie's 'site': a page served on another local
 * port is same-site and would carry the session, and this server opens terminals.
 * Every request, including WebSocket handshakes, therefore has two checks:
 * - `Host` must be the local address, preventing DNS rebinding (an arbitrary
 *   domain resolving to 127.0.0.1);
 * - `Origin`, when sent by the browser (always for WebSockets and POST), must
 *   match that address. Non-browser clients (curl, token-based MCP clients)
 *   send none and are allowed through.
 */
export function registerLocalOriginGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    const port = request.socket.localPort
    const host = request.headers.host ?? ''
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      throw new HttpError(403, 'forbidden_host', 'This instance only answers on its local address.')
    }
    const origin = request.headers.origin
    if (origin !== undefined && origin !== `http://${host}`) {
      throw new HttpError(403, 'forbidden_origin', 'This instance only answers the Sillage window.')
    }
  })
}
