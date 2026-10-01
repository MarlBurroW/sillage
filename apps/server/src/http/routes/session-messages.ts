import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { conversations } from '@sillage/db'
import type { SessionRelay } from '../../sessions/session-relay.js'
import type { AppContext } from '../context.js'
import { badRequest, forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/**
 * Ce qu'une personne peut faire d'un message de session que Sillage a retenu : le
 * remettre malgré les garde-fous, ou l'écarter.
 *
 * Réservé à la propriétaire de la conversation destinataire, comme l'envoi d'un
 * message : remettre relance son agent, donc dépense pour son compte.
 */
export function registerSessionMessageRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  relay: SessionRelay,
): void {
  const loadOwned = (conversationId: string, userId: string) => {
    const conversation = ctx.db
      .select({ userId: conversations.userId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get()
    if (!conversation) throw notFound('conversation_not_found', 'Conversation not found.')
    if (conversation.userId !== userId) {
      throw forbidden('conversation_write_forbidden', 'Only the conversation owner can write to it.')
    }
  }

  const gone = () =>
    badRequest('session_message_gone', 'This message has already been delivered or discarded.')

  app.post('/api/conversations/:id/session-messages/:messageId/release', async (request, reply) => {
    const user = requireUser(request)
    const { id, messageId } = request.params as { id: string; messageId: string }
    loadOwned(id, user.id)

    if (!(await relay.release(id, messageId))) throw gone()
    return reply.status(202).send({ accepted: true })
  })

  app.delete('/api/conversations/:id/session-messages/:messageId', async (request, reply) => {
    const user = requireUser(request)
    const { id, messageId } = request.params as { id: string; messageId: string }
    loadOwned(id, user.id)

    if (!relay.discard(id, messageId)) throw gone()
    return reply.status(204).send()
  })
}
