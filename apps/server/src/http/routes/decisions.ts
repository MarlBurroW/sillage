import type { FastifyInstance } from 'fastify'
import { answerDecisionBodySchema, requestedDecisionSources } from '@sillage/protocol'
import type { DecisionService } from '../../decisions/service.js'
import { requireUser } from '../require-user.js'

/** Les décisions du compte : celles qui attendent, l'historique, et la réponse. */
export function registerDecisionRoutes(app: FastifyInstance, decisions: DecisionService): void {
  app.get('/api/decisions', async (request) => {
    const user = requireUser(request)
    const { status, sources } = request.query as { status?: string; sources?: string }
    return { decisions: decisions.list(user.id, status === 'all' ? 'all' : 'pending', requestedDecisionSources(sources)) }
  })

  app.get('/api/decisions/:id', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { sources } = request.query as { sources?: string }
    // Introuvable plutôt qu'affichée de travers : un ancien onglet ouvert depuis un toast
    // dit « décision introuvable » au lieu de planter.
    return decisions.get(user.id, id, requestedDecisionSources(sources))
  })

  app.post('/api/decisions/:id/answer', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    return decisions.answer(user.id, id, answerDecisionBodySchema.parse(request.body))
  })
}
