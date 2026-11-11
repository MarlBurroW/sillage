import type { FastifyInstance } from 'fastify'
import type { RemoteAccessState } from '@sillage/protocol'
import type { RemoteAccessService } from '../../remote-access/service.js'
import { requireAdmin } from '../require-user.js'

/**
 * Desktop remote access. Registered only on the desktop profile: a server instance has no
 * launcher-owned port to forward and is reached through its own address.
 */
export function registerRemoteAccessRoutes(app: FastifyInstance, service: RemoteAccessService): void {
  app.get('/api/remote-access', async (request): Promise<RemoteAccessState> => {
    requireAdmin(request)
    return service.state()
  })

  app.post('/api/remote-access/enable', async (request): Promise<RemoteAccessState> => {
    requireAdmin(request)
    return service.enable()
  })

  app.post('/api/remote-access/disable', async (request): Promise<RemoteAccessState> => {
    requireAdmin(request)
    return service.disable()
  })
}
