import type { ServiceAppAction, ServicesDto } from '@sillage/protocol'
import type { FastifyInstance } from 'fastify'
import { controlServiceApp, scanServiceApps } from '../../services/apps.js'
import { readProcessHost } from '../../services/ownership.js'
import { stopServiceProcess } from '../../services/processes.js'
import { serviceView } from '../../services/visible.js'
import type { AppContext } from '../context.js'
import { HttpError } from '../errors.js'
import { requireUser } from '../require-user.js'

export function registerServiceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { origins, scan, visible, visibleApps, scannedAt, invalidate } = serviceView(ctx)

  app.get('/api/services', async (request): Promise<ServicesDto> => {
    const user = requireUser(request)
    if (process.platform !== 'linux') return { supported: false, scannedAt: Date.now(), services: [], apps: [] }
    const [processes, apps] = await Promise.all([scan(), scanServiceApps(origins)])
    return {
      supported: true, scannedAt: scannedAt(),
      services: visible(processes, user.id, user.isAdmin),
      apps: visibleApps(apps, user.id, user.isAdmin),
    }
  })

  app.post('/api/services/:id/stop', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    if (process.platform !== 'linux') throw new HttpError(409, 'services_unsupported', 'Service discovery requires Linux.')
    const processes = await scan(true)
    const service = visible(processes, user.id, user.isAdmin).find((entry) => entry.id === id)
    if (!service) throw new HttpError(404, 'service_gone', 'This service is no longer available.')
    if (!service.canStop) throw new HttpError(409, 'service_untracked', 'The origin of this service is unknown.')
    if (!stopServiceProcess(processes.find((entry) => entry.id === id)!, origins, await readProcessHost())) {
      throw new HttpError(409, 'service_changed', 'The service has changed or could not be stopped. Refresh the list.')
    }
    invalidate()
    return reply.status(202).send({ stopping: true })
  })

  app.post('/api/services/apps/:id/:action', async (request, reply) => {
    const user = requireUser(request)
    const { id, action } = request.params as { id: string; action: string }
    if (!['stop', 'restart', 'reset'].includes(action)) throw new HttpError(404, 'not_found', 'Unknown action.')
    if (process.platform !== 'linux') throw new HttpError(409, 'services_unsupported', 'Service discovery requires Linux.')
    const app = visibleApps(await scanServiceApps(origins), user.id, user.isAdmin).find((entry) => entry.id === id)
    if (!app) throw new HttpError(404, 'service_gone', 'This app is no longer available. Refresh the list.')
    const allowed = action === 'stop' ? app.canStop : action === 'restart' ? app.canRestart : app.canReset
    if (!allowed) throw new HttpError(409, 'service_app_refused', 'This action is not available for this app.')
    try {
      await controlServiceApp(app.unit, action as ServiceAppAction)
    } catch (err) {
      throw new HttpError(409, 'service_app_failed', `systemd refused: ${err instanceof Error ? err.message : String(err)}`)
    }
    return reply.status(202).send({ accepted: true })
  })
}
