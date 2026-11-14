import type { FastifyInstance, FastifyRequest } from 'fastify'
import { HttpError } from './errors.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Reject URL syntax that could turn a Host header into a different authority. */
function hostUrl(host: string | undefined, protocol: string): URL | null {
  if (!host || /[\s\\/@?#]/.test(host)) return null
  try {
    return new URL(`${protocol}://${host}`)
  } catch {
    return null
  }
}

function listenerHost(request: FastifyRequest): boolean {
  const target = hostUrl(request.headers.host, 'http')
  if (!target || Number(target.port || 80) !== request.socket.localPort) return false
  const address = request.socket.localAddress
  const hostname = target.hostname.replace(/^\[|\]$/g, '')
  return hostname === address || hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost'
}

/**
 * SameSite cookies also reach sibling subdomains. Check browser writes and both
 * WebSockets before their handlers can read conversations or attach a terminal.
 *
 * publicUrl pins the public host and origin when configured; the listener's own
 * address remains available to local clients and health probes. Without it, infer
 * the origin from Host and the proxy's protocol, so domain and LAN installations
 * work before onboarding. Desktop has its stricter local/tailnet guard instead.
 * Register after identity resolution: a verified API token does not rely on cookies.
 */
export function registerServerOriginGuard(app: FastifyInstance, publicUrl: () => string): void {
  app.addHook('onRequest', async (request) => {
    const configured = publicUrl()
    let publicOrigin: URL | null = null
    if (configured) {
      try { publicOrigin = new URL(configured) } catch { /* Invalid configuration fails closed. */ }
      if (!publicOrigin || !['http:', 'https:'].includes(publicOrigin.protocol)) {
        throw new HttpError(403, 'forbidden_host', 'The configured public URL is invalid.')
      }
    }

    const local = listenerHost(request)
    const target = hostUrl(request.headers.host, !local && publicOrigin ? publicOrigin.protocol.slice(0, -1) : request.protocol)
    if (!target || (publicOrigin && target.host !== publicOrigin.host && !local)) {
      throw new HttpError(403, 'forbidden_host', 'This instance only answers on its configured address.')
    }

    const upgrade = request.headers.upgrade?.toLowerCase() === 'websocket'
    if (!upgrade && SAFE_METHODS.has(request.method)) return
    if (request.apiToken && request.url.startsWith('/api/v1/')) return

    const origin = request.headers.origin
    if (origin === undefined) {
      // Non-browser clients omit Origin; browser metadata must not turn its
      // absence into an escape hatch for a cross-site or sibling-site request.
      const site = request.headers['sec-fetch-site']
      if (site !== 'cross-site' && site !== 'same-site') return
    } else if (origin === publicOrigin?.origin || origin === target.origin) {
      return
    }

    throw new HttpError(403, 'forbidden_origin', 'This request must come from the Sillage instance.')
  })
}
