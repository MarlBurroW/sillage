import type { FastifyInstance } from 'fastify'
import {
  pushSubscribeBodySchema,
  pushUnsubscribeBodySchema,
  type PushStatusDto,
} from '@sillage/protocol'
import type { PushService } from '../../push/push-service.js'
import { requireUser } from '../require-user.js'

/**
 * Abonnement aux notifications.
 *
 * L'abonnement appartient au couple compte + appareil : le même navigateur connecté
 * sous un autre compte produit un endpoint distinct, et rien ne fuit de l'un à l'autre.
 */
export function registerPushRoutes(app: FastifyInstance, push: PushService): void {
  app.get('/api/push', async (request): Promise<PushStatusDto> => {
    const user = requireUser(request)
    return { publicKey: push.publicKey, subscribed: push.hasSubscriptions(user.id) }
  })

  app.post('/api/push/subscribe', async (request) => {
    const user = requireUser(request)
    const body = pushSubscribeBodySchema.parse(request.body)
    push.subscribe(user.id, body, request.headers['user-agent'])
    return { ok: true }
  })

  app.post('/api/push/unsubscribe', async (request, reply) => {
    requireUser(request)
    const body = pushUnsubscribeBodySchema.parse(request.body)
    push.unsubscribe(body.endpoint)
    return reply.status(204).send()
  })
}
