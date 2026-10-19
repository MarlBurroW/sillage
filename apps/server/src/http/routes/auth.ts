import { randomUUID } from 'node:crypto'
import { count, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { users, writeTransaction } from '@sillage/db'
import { loginBodySchema, setupAccountBodySchema, type CurrentUser } from '@sillage/protocol'
import { hashPassword, verifyPassword } from '../../auth/passwords.js'
import { INSTANCE_PROFILE } from '../../instance/profile.js'
import { armOnboarding } from '../../settings/user-settings.js'
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

  /**
   * Le premier compte, créé depuis la visite quand la base n'en a aucun.
   *
   * Publique, mais fermée dès qu'un compte existe : c'est l'absence de compte qui vaut
   * autorisation, et le comptage se fait dans la même transaction que l'insertion pour
   * que deux navigateurs ouverts au même moment n'en créent pas deux. La session s'ouvre
   * dans la foulée : la visite continue sans passer par la page de connexion.
   */
  app.post('/api/auth/setup', async (request, reply) => {
    if (INSTANCE_PROFILE === 'desktop') {
      throw new HttpError(404, 'not_found', 'Not found.')
    }
    const body = setupAccountBodySchema.parse(request.body)
    const passwordHash = await hashPassword(body.password)

    const row = writeTransaction(ctx.db, (tx) => {
      const [tally] = tx.select({ total: count() }).from(users).all()
      if ((tally?.total ?? 0) > 0) {
        throw new HttpError(409, 'setup_done', 'This instance already has an account.')
      }
      const created = {
        id: randomUUID(),
        username: body.username,
        passwordHash,
        displayName: body.displayName,
        isAdmin: true,
        createdAt: Date.now(),
      }
      tx.insert(users).values(created).run()
      return created
    })
    armOnboarding(ctx.db, row.id)

    const { token } = await createSession(ctx.db, row.id, request.headers['user-agent'])
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecure(request),
      maxAge: SESSION_TTL_MS / 1000,
    })
    return reply.status(201).send(toCurrentUser(row))
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
