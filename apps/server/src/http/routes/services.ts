import { conversations, projects } from '@sillage/db'
import type { ServiceDto, ServicesDto } from '@sillage/protocol'
import type { FastifyInstance } from 'fastify'
import { readProcessHost } from '../../services/ownership.js'
import { processOrigins } from '../../services/origins.js'
import { scanServiceProcesses, stopServiceProcess, type ServiceProcess } from '../../services/processes.js'
import type { AppContext } from '../context.js'
import { HttpError } from '../errors.js'
import { requireUser } from '../require-user.js'

export function registerServiceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const origins = processOrigins(ctx.config.paths.data)
  let pending: Promise<ServiceProcess[]> | undefined
  let cached: { processes: ServiceProcess[]; at: number } | undefined
  const scan = async (fresh = false): Promise<ServiceProcess[]> => {
    if (!fresh && cached && Date.now() - cached.at < 2000) return cached.processes
    return pending ??= scanServiceProcesses(origins).then((processes) => {
      cached = { processes, at: Date.now() }
      return processes
    }).finally(() => { pending = undefined })
  }

  const visible = (processes: ServiceProcess[], userId: string, isAdmin: boolean): ServiceDto[] => {
    const allProjects = ctx.db.select().from(projects).all()
    const allConversations = new Map(ctx.db.select({
      id: conversations.id, projectId: conversations.projectId, title: conversations.title,
    }).from(conversations).all().map((row) => [row.id, row]))
    return processes.flatMap((entry): ServiceDto[] => {
      const projectId = entry.origin?.projectId
      const project = allProjects.find((candidate) => candidate.id === projectId)
      if (project ? project.ownerId !== userId && project.visibility !== 'shared' : !isAdmin) return []
      const conversation = entry.origin?.conversationId && allConversations.get(entry.origin.conversationId)
      const linked = conversation && conversation.projectId === project?.id ? conversation : null
      return [{
        id: entry.id, pid: entry.pid, name: entry.name, cwd: entry.cwd, ports: entry.ports,
        startedAt: entry.startedAt, memoryBytes: entry.memoryBytes,
        parentPid: entry.parentPid, parentName: entry.parentName,
        relation: entry.relation, stopsWithSillage: entry.stopsWithSillage, launcher: entry.launcher,
        projectId: project?.id ?? null, projectName: project?.name ?? null,
        conversationId: linked?.id ?? null, conversationTitle: linked?.title ?? null,
        origin: entry.origin ? entry.origin.conversationId ? 'agent' : 'terminal' : 'unknown',
        canStop: !!entry.origin && !!project && !entry.launcher,
      }]
    })
  }

  app.get('/api/services', async (request): Promise<ServicesDto> => {
    const user = requireUser(request)
    if (process.platform !== 'linux') return { supported: false, scannedAt: Date.now(), services: [] }
    const processes = await scan()
    return { supported: true, scannedAt: cached!.at, services: visible(processes, user.id, user.isAdmin) }
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
    cached = undefined
    return reply.status(202).send({ stopping: true })
  })
}
