import type { FastifyError, FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

/**
 * Erreur destinée au client, sous la forme `{ code, params?, message }`.
 *
 * Le `code` est ce que l'interface traduit ; le `message` est écrit en anglais et sert
 * de repli lisible, pour les logs et pour ce qui appelle l'API hors de l'interface. Le
 * serveur ne connaît donc jamais la langue de l'utilisateur, ce qui vaut aussi pour le
 * WebSocket, où aucune préférence ne transite.
 *
 * `params` porte ce que le message interpole. Sans lui, la traduction côté client ne
 * pourrait pas reconstruire une phrase qui nomme un fichier ou un agent, et devrait se
 * rabattre sur une formule vague.
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
 * `code` est obligatoire sur ces deux-là, et ce n'est pas une formalité.
 *
 * Ils partageaient auparavant un code unique pour 12 et 11 situations distinctes, du
 * « seul le propriétaire peut supprimer ce projet » au « worktree introuvable ». Un
 * client qui traduit par code les aurait toutes écrasées en une phrase générique, donc
 * moins informative que le français en dur qu'on remplace.
 */
export const forbidden = (code: string, message: string, params?: Params) =>
  new HttpError(403, code, message, params)
export const notFound = (code: string, message: string, params?: Params) =>
  new HttpError(404, code, message, params)
export const conflict = (code: string, message: string, params?: Params) =>
  new HttpError(409, code, message, params)

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

      // Le message renvoyé au client dit quel champ est en cause, jamais la valeur
      // reçue. Sans le corps rejeté côté serveur, un refus de validation est
      // indiagnosticable : on ne sait pas ce que le client a réellement envoyé.
      request.log.warn(
        { issues: err.issues, body: redactBody(request.url, request.body) },
        'requête rejetée par la validation',
      )

      // `detail` part aussi en paramètre : la traduction de `validation_failed`
      // l'interpole, et sans lui l'utilisateur lit « Requête invalide : {detail} ».
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
