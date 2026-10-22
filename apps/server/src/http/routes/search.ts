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
 * Searches message content.
 *
 * Conversation titles are excluded: the full navigation list is already loaded
 * client-side, so in-memory filtering responds to typing without a network trip.
 */
export function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/search', async (request): Promise<SearchMessageDto[]> => {
    const user = requireUser(request)
    const { q } = request.query as { q?: string }

    // Very short queries would return much of the journal in nearly random order.
    // Reject rather than serve them; the client applies the same threshold.
    const query = q?.trim() ?? ''
    if (query.length < SEARCH_MIN_QUERY) return []

    return searchMessages(ctx.db, user.id, query, SEARCH_RESULT_LIMIT)
  })
}
