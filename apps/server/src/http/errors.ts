import type { FastifyError, FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

/**
 * Client-facing error shaped as `{ code, params?, message }`.
 *
 * The interface translates `code`; the English `message` is a readable fallback
 * for logs and external API callers. The server never needs the user's language,
 * including over WebSocket, which carries no language preference.
 *
 * `params` supplies interpolated values. Without it, client translations could
 * not name files or agents and would have to fall back to vague wording.
 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

type Params = Record<string, string | number>

export const badRequest = (code: string, message: string, params?: Params) =>
  new HttpError(400, code, message, params)
export const unauthorized = () => new HttpError(401, 'unauthorized', 'Authentication required.')

/**
 * `code` is mandatory for these two errors for a reason.
 *
 * They previously shared one code across 12 and 11 distinct situations, from
 * owner-only project deletion to missing worktrees. Code-based translation
 * would flatten them into a generic sentence less informative than the hardcoded
 * French being replaced.
 */
export const forbidden = (code: string, message: string, params?: Params) =>
  new HttpError(403, code, message, params)
export const notFound = (code: string, message: string, params?: Params) =>
  new HttpError(404, code, message, params)
export const conflict = (code: string, message: string, params?: Params) =>
  new HttpError(409, code, message, params)

/**
 * All errors use { error: { code, message } } so the UI needs only one display path.
 */
/** Routes whose request bodies must never appear in logs. */
const SENSITIVE_ROUTES = ['/api/auth/login', '/api/exports/']

function redactBody(url: string, body: unknown): unknown {
  const path = url.split('?')[0] ?? url
  if (SENSITIVE_ROUTES.some((route) => path.startsWith(route))) return '[masqué]'
  return body
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof HttpError) {
      // A 5xx describes a failure rather than a client mistake: without this line,
      // failed agent probes left no server trace. The message contains the CLI's
      // explanation (missing binary, unauthenticated, too slow); 502 alone says nothing.
      // Keep 4xx responses silent: they are expected and frequent.
      if (err.statusCode >= 500) {
        request.log.error({ err, code: err.code, params: err.params }, err.message)
      }
      return reply.status(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.params ? { params: err.params } : {}),
        },
      })
    }

    if (err instanceof ZodError) {
      const detail = err.issues
        .map((i) => `${i.path.join('.') || 'corps'}: ${i.message}`)
        .join(', ')

      // The client response identifies the offending field, never the received value.
      // Without the rejected body in server logs, validation failures cannot be
      // diagnosed: the client's actual input would be unknown.
      request.log.warn(
        { issues: err.issues, body: redactBody(request.url, request.body) },
        'requête rejetée par la validation',
      )

      // Also pass `detail` as a parameter: the `validation_failed` translation
      // interpolates it; otherwise users see 'Invalid request: {detail}'.
      return reply
        .status(400)
        .send({ error: { code: 'validation_failed', message: detail, params: { detail } } })
    }

    if (err.statusCode && err.statusCode < 500) {
      return reply
        .status(err.statusCode)
        .send({ error: { code: err.code ?? 'bad_request', message: err.message } })
    }

    request.log.error({ err }, 'erreur non gérée')
    return reply
      .status(500)
      .send({ error: { code: 'internal_error', message: 'Erreur interne du serveur.' } })
  })
}
