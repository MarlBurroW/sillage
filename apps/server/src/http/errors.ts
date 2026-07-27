import type { FastifyError, FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const badRequest = (code: string, message: string) => new HttpError(400, code, message)
export const unauthorized = () =>
  new HttpError(401, 'unauthorized', 'Authentification requise.')
export const forbidden = (message = 'Accès refusé.') =>
  new HttpError(403, 'forbidden', message)
export const notFound = (message = 'Ressource introuvable.') =>
  new HttpError(404, 'not_found', message)
export const conflict = (code: string, message: string) => new HttpError(409, code, message)

/**
 * Toutes les erreurs sortent sous la forme { error: { code, message } } pour que
 * l'UI n'ait qu'un seul chemin d'affichage.
 */
/** Routes dont le corps ne doit jamais atterrir dans les journaux. */
const SENSITIVE_ROUTES = ['/api/auth/login']

function redactBody(url: string, body: unknown): unknown {
  const path = url.split('?')[0] ?? url
  if (SENSITIVE_ROUTES.some((route) => path.startsWith(route))) return '[masqué]'
  return body
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    }

    if (err instanceof ZodError) {
      const detail = err.issues
        .map((i) => `${i.path.join('.') || 'corps'}: ${i.message}`)
        .join(', ')

      // Le message renvoyé au client dit quel champ est en cause, jamais la valeur
      // reçue. Sans le corps rejeté côté serveur, un refus de validation est
      // indiagnosticable : on ne sait pas ce que le client a réellement envoyé.
      request.log.warn(
        { issues: err.issues, body: redactBody(request.url, request.body) },
        'requête rejetée par la validation',
      )

      return reply
        .status(400)
        .send({ error: { code: 'validation_failed', message: detail } })
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
