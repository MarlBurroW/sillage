import type { FastifyInstance } from 'fastify'
import { answerDecisionBodySchema } from '@sillage/protocol'
import type { DecisionService } from '../../decisions/service.js'
import { requireUser } from '../require-user.js'

/** Les décisions du compte : celles qui attendent, l'historique, et la réponse. */
export function registerDecisionRoutes(app: FastifyInstance, decisions: DecisionService): void {
  app.get('/api/decisions', async (request) => {
    const user = requireUser(request)
    const { status } = request.query as { status?: string }
    return { decisions: decisions.list(user.id, status === 'all' ? 'all' : 'pending') }
  })

  app.get('/api/decisions/:id', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    return decisions.get(user.id, id)
  })

  app.post('/api/decisions/:id/answer', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    return decisions.answer(user.id, id, answerDecisionBodySchema.parse(request.body))
  })
}
