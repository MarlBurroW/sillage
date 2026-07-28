import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { users } from '@sillage/db'
import { loginBodySchema, type CurrentUser } from '@sillage/protocol'
import { verifyPassword } from '../../auth/passwords.js'
import {
  createSession,
  destroySession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '../../auth/sessions.js'
import type { AppContext } from '../context.js'
import { HttpError } from '../errors.js'
import { requireUser } from '../require-user.js'

const LOGIN_WINDOW_MS = 60_000
const LOGIN_MAX_ATTEMPTS = 5

/** Limitation de débit du login, en mémoire : le daemon est un process unique. */
class LoginThrottle {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>()

  check(ip: string): void {
    const now = Date.now()
    const entry = this.attempts.get(ip)

    if (!entry || entry.resetAt <= now) {
      this.attempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
      return
    }

    entry.count += 1
    if (entry.count > LOGIN_MAX_ATTEMPTS) {
      const retryIn = Math.ceil((entry.resetAt - now) / 1000)
      throw new HttpError(
        429,
        'too_many_attempts',
        'Too many attempts. Try again in {seconds} seconds.',
        { seconds: retryIn },
      )
    }
  }

  clear(ip: string): void {
    this.attempts.delete(ip)
  }
}

export function toCurrentUser(row: {
  id: string
  username: string
  displayName: string
  isAdmin: boolean
}): CurrentUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    isAdmin: row.isAdmin,
  }
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const throttle = new LoginThrottle()

  /**
   * `Secure` décidé par requête, pas par variable d'environnement.
   *
   * La même instance est jointe à la fois en clair sur le réseau local et en HTTPS
   * derrière l'ingress. Un `Secure` global rendrait la connexion impossible en clair,
   * et son absence priverait la connexion chiffrée de la protection. `trustProxy` est
   * actif, donc `request.protocol` reflète `X-Forwarded-Proto`.
   */
  const isSecure = (request: FastifyRequest): boolean => request.protocol === 'https'

  app.post('/api/auth/login', async (request, reply) => {
    throttle.check(request.ip)
    const body = loginBodySchema.parse(request.body)

    const row = (
      await ctx.db.select().from(users).where(eq(users.username, body.username)).limit(1)
    )[0]

    // Message identique dans les deux cas : ne pas révéler l'existence d'un compte.
    const invalid = new HttpError(401, 'invalid_credentials', 'Incorrect username or password.')
    if (!row) throw invalid
    if (!(await verifyPassword(row.passwordHash, body.password))) throw invalid

    const { token } = await createSession(ctx.db, row.id, request.headers['user-agent'])
    throttle.clear(request.ip)

    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecure(request),
      maxAge: SESSION_TTL_MS / 1000,
    })

    return toCurrentUser(row)
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE]
    if (token) await destroySession(ctx.db, token)
    reply.clearCookie(SESSION_COOKIE, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecure(request),
    })
    return reply.status(204).send()
  })

  app.get('/api/auth/me', async (request) => toCurrentUser(requireUser(request)))
}
