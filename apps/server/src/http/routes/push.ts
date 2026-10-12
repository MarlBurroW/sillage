import type { FastifyInstance } from 'fastify'
import {
  pushSubscribeBodySchema,
  pushTestBodySchema,
  pushUnsubscribeBodySchema,
  type PushStatusDto,
} from '@sillage/protocol'
import type { FastifyRequest } from 'fastify'
import type { PushService } from '../../push/push-service.js'
import { notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/** L'adresse par laquelle le navigateur joint l'instance, telle qu'il la voit. */
function originOf(request: FastifyRequest): string | undefined {
  const origin = request.headers.origin
  if (typeof origin === 'string' && origin) return origin
  const host = request.headers['x-forwarded-host'] ?? request.headers.host
  const proto = request.headers['x-forwarded-proto'] ?? request.protocol
  return typeof host === 'string' ? `${String(proto).split(',')[0]}://${host}` : undefined
}

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
    push.subscribe(user.id, body, request.headers['user-agent'], originOf(request))
    return { ok: true }
  })

  app.get('/api/push/devices', async (request) => {
    const user = requireUser(request)
    return { devices: push.devices(user.id) }
  })

  app.post('/api/push/devices/remove', async (request, reply) => {
    const user = requireUser(request)
    const body = pushUnsubscribeBodySchema.parse(request.body)
    if (!push.removeDevice(user.id, body.endpoint)) throw notFound('push_device_not_found', 'Device not found.')
    return reply.status(204).send()
  })

  /** Une notification d'essai, après un délai pour avoir le temps de fermer l'application. */
  app.post('/api/push/test', async (request) => {
    const user = requireUser(request)
    const body = pushTestBodySchema.parse(request.body)
    return push.scheduleTest(user.id, body.delaySeconds)
  })

  app.get('/api/push/test/:id', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const test = push.test(user.id, id)
    if (!test) throw notFound('push_test_not_found', 'Test not found.')
    return test
  })

  app.post('/api/push/unsubscribe', async (request, reply) => {
    requireUser(request)
    const body = pushUnsubscribeBodySchema.parse(request.body)
    push.unsubscribe(body.endpoint)
    return reply.status(204).send()
  })
}
