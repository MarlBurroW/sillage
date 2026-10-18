import type { FastifyInstance } from 'fastify'
import { HttpError } from './errors.js'

/**
 * Réserve une instance de bureau à la fenêtre de l'application.
 *
 * Le serveur écoute sur 127.0.0.1, que toute page ouverte dans un navigateur du poste
 * peut joindre. Le port ne compte pas dans le « site » d'un cookie : une page servie sur
 * un autre port local est same-site et emporterait la session, et ce serveur ouvre des
 * terminaux. Deux contrôles, donc, sur chaque requête, poignée de main WebSocket
 * comprise :
 * - `Host` doit être l'adresse locale, ce qui écarte le DNS rebinding (un domaine
 *   quelconque qui se résoudrait vers 127.0.0.1) ;
 * - `Origin`, quand le navigateur l'envoie (toujours pour une WebSocket ou un POST), doit
 *   être cette même adresse. Un client hors navigateur (curl, un client MCP par jeton)
 *   n'en envoie pas, et passe.
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
