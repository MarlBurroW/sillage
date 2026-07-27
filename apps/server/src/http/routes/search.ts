import type { FastifyInstance } from 'fastify'
import {
  SEARCH_MIN_QUERY,
  SEARCH_RESULT_LIMIT,
  type SearchMessageDto,
} from '@sillage/protocol'
import { searchMessages } from '../../search/search-messages.js'
import type { AppContext } from '../context.js'
import { requireUser } from '../require-user.js'

/**
 * Recherche dans le contenu des messages.
 *
 * Les titres de conversations ne passent pas par ici : la liste complète est déjà
 * chargée côté client pour la navigation, donc les filtrer en mémoire répond à la
 * frappe sans aller-retour réseau.
 */
export function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/search', async (request): Promise<SearchMessageDto[]> => {
    const user = requireUser(request)
    const { q } = request.query as { q?: string }

    // Une requête trop courte ramènerait une part notable du journal, classée presque
    // au hasard. Refuser plutôt que servir : le client applique le même seuil.
    const query = q?.trim() ?? ''
    if (query.length < SEARCH_MIN_QUERY) return []

    return searchMessages(ctx.db, user.id, query, SEARCH_RESULT_LIMIT)
  })
}
