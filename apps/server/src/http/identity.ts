import type { FastifyInstance } from 'fastify'
import { bearerSecret, resolveApiToken } from '../auth/api-tokens.js'
import { SESSION_COOKIE, SESSION_TTL_MS, resolveSession } from '../auth/sessions.js'
import { openTailnetSession } from '../instance/desktop.js'
import type { AppContext } from './context.js'

/**
 * Resolves identity on every request. Routes then decide whether they require a user
 * through `requireUser()`.
 */
export function registerIdentityHook(app: FastifyInstance, ctx: AppContext): void {
  app.addHook('onRequest', async (request, reply) => {
    const secret = bearerSecret(request.headers.authorization)
    const identity = secret ? resolveApiToken(ctx.db, secret) : null
    if (identity) {
      request.apiToken = identity.token
      request.user = identity.user
      return
    }

    // Fall back to cookies even with an `Authorization` header: a proxy or
    // extension adding one must not make the interface unusable.
    const token = request.cookies[SESSION_COOKIE]
    const user = token ? await resolveSession(ctx.db, token) : null
    if (user) {
      request.user = user
      return
    }

    // A device relayed by Tailscale Serve for the recognised tailnet login (desktop
    // guard): open the sole account's session rather than show a login page the
    // desktop profile does not have. The launcher resets sessions at each start,
    // so the device's cookie dies then and the next request opens a new one.
    if (!request.tailnetLogin) return
    const opened = await openTailnetSession(ctx.db, `${request.headers['user-agent'] ?? ''} via Tailscale (${request.tailnetLogin})`)
    if (!opened) return
    reply.setCookie(SESSION_COOKIE, opened.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: request.protocol === 'https',
      maxAge: SESSION_TTL_MS / 1000,
    })
    request.user = opened.user
  })
}
