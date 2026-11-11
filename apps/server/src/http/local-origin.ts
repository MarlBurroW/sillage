import type { FastifyInstance } from 'fastify'
import { BENCHMARK_PREVIEW_PREFIX } from '@sillage/protocol'
import { HttpError } from './errors.js'

/** Who may reach a desktop instance from the tailnet; null while remote access is off. */
export interface RemoteAccessGate {
  allowed(): { hostname: string; login: string } | null
}

/** Set when Tailscale Serve relayed the request for the recognised tailnet account. */
export const TAILNET_LOGIN_HEADER = 'tailscale-user-login'

/**
 * Restricts a desktop instance to the application window, and to the user's own devices
 * once remote access is on.
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
 *
 * With remote access enabled, requests relayed by Tailscale Serve arrive on the same
 * port with `Host` set to the recorded tailnet hostname. Serve strips any
 * `Tailscale-User-*` headers the client sent and writes the caller's tailnet
 * identity itself, so the login header is authoritative for traffic on that
 * hostname; Funnel visitors have none and are refused. Only the recorded login
 * passes: another member of a shared tailnet is not the machine's owner. Nothing
 * resolves the tailnet hostname to 127.0.0.1 outside Tailscale, so rebinding
 * still needs the exact hostname and cannot forge the header.
 */
export function registerLocalOriginGuard(app: FastifyInstance, remote: RemoteAccessGate): void {
  app.addHook('onRequest', async (request) => {
    const port = request.socket.localPort
    const host = request.headers.host ?? ''
    const origin = request.headers.origin
    if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) {
      // A benchmark preview is a sandboxed document: its module scripts and fetches announce the
      // opaque origin `null`. Those reads stay confined to the run's files by its token.
      const preview = origin === 'null' && request.method === 'GET' && request.url.startsWith(BENCHMARK_PREVIEW_PREFIX)
      if (origin !== undefined && origin !== `http://${host}` && !preview) {
        throw new HttpError(403, 'forbidden_origin', 'This instance only answers the Sillage window.')
      }
      return
    }

    const allowed = remote.allowed()
    if (allowed && host.replace(/:\d+$/, '') === allowed.hostname) {
      const login = request.headers[TAILNET_LOGIN_HEADER]
      if (login !== allowed.login) {
        throw new HttpError(403, 'forbidden_identity', 'This instance only answers its owner on the tailnet.')
      }
      if (origin !== undefined && origin !== `https://${host}`) {
        throw new HttpError(403, 'forbidden_origin', 'This instance only answers the Sillage window.')
      }
      request.tailnetLogin = login
      return
    }

    throw new HttpError(403, 'forbidden_host', 'This instance only answers on its local address.')
  })
}
