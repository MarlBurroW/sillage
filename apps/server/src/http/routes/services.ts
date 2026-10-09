import { conversations, projects } from '@sillage/db'
import type { ServiceAppAction, ServiceAppDto, ServiceDto, ServicesDto } from '@sillage/protocol'
import type { FastifyInstance } from 'fastify'
import { controlServiceApp, scanServiceApps, type ServiceApp } from '../../services/apps.js'
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

  /**
   * Le projet et la conversation d'une origine, ou null si l'utilisateur ne doit pas
   * voir l'entrée : un projet privé d'un autre, ou une origine inconnue hors admin.
   */
  const attribution = (userId: string, isAdmin: boolean) => {
    const allProjects = ctx.db.select().from(projects).all()
    const allConversations = new Map(ctx.db.select({
      id: conversations.id, projectId: conversations.projectId, title: conversations.title,
    }).from(conversations).all().map((row) => [row.id, row]))
    return (origin: ServiceProcess['origin']) => {
      const project = allProjects.find((candidate) => candidate.id === origin?.projectId)
      if (project ? project.ownerId !== userId && project.visibility !== 'shared' : !isAdmin) return null
      const conversation = origin?.conversationId && allConversations.get(origin.conversationId)
      const linked = conversation && conversation.projectId === project?.id ? conversation : null
      return { project: project ?? null, conversation: linked || null }
    }
  }

  const visible = (processes: ServiceProcess[], userId: string, isAdmin: boolean): ServiceDto[] => {
    const attribute = attribution(userId, isAdmin)
    return processes.flatMap((entry): ServiceDto[] => {
      const seen = attribute(entry.origin)
      if (!seen) return []
      const { project, conversation: linked } = seen
      return [{
        id: entry.id, kind: entry.kind, pid: entry.pid, name: entry.name, command: entry.command,
        parentPid: entry.parentPid, parentName: entry.parentName, launcherPid: entry.launcherPid,
        stopsWithSillage: entry.stopsWithSillage, cwd: entry.cwd, ports: entry.ports,
        startedAt: entry.startedAt, memoryBytes: entry.memoryBytes,
        processCount: entry.processCount, processes: entry.processes,
        projectId: project?.id ?? null, projectName: project?.name ?? null,
        conversationId: linked?.id ?? null, conversationTitle: linked?.title ?? null,
        origin: entry.origin ? entry.origin.conversationId ? 'agent' : 'terminal' : 'unknown',
        // Un lanceur se pilote depuis sa conversation ou son terminal ; un outil d'agent
        // (serveur MCP) arrêté ici casserait la conversation sans rien libérer d'utile.
        canStop: !!entry.origin && !!project && (entry.kind === 'command' || entry.kind === 'detached'),
      }]
    })
  }

  /**
   * Les apps suivent la visibilité des processus. Une seule différence : sans origine
   * connue, l'admin peut aussi les piloter. Le préfixe `sillage-app-` est en soi une
   * déclaration (« Sillage peut l'arrêter »), et l'admin a de toute façon la main sur
   * les unités de la machine ; un agent qui a oublié de transmettre son jeton ne doit
   * pas laisser une app impossible à arrêter depuis l'interface.
   */
  const visibleApps = (apps: ServiceApp[], userId: string, isAdmin: boolean): ServiceAppDto[] => {
    const attribute = attribution(userId, isAdmin)
    return apps.flatMap((entry): ServiceAppDto[] => {
      const seen = attribute(entry.origin)
      if (!seen) return []
      const { project, conversation } = seen
      const manageable = !!project || isAdmin
      const running = ['active', 'activating', 'reloading'].includes(entry.state)
      return [{
        id: entry.id, unit: entry.unit, description: entry.description, executable: entry.executable, command: entry.command,
        state: entry.state, subState: entry.subState, result: entry.result, mainPid: entry.mainPid,
        ports: entry.ports, cwd: entry.cwd, startedAt: entry.startedAt, memoryBytes: entry.memoryBytes,
        enabled: entry.enabled, transient: entry.transient,
        projectId: project?.id ?? null, projectName: project?.name ?? null,
        conversationId: conversation?.id ?? null, conversationTitle: conversation?.title ?? null,
        origin: entry.origin ? entry.origin.conversationId ? 'agent' : 'terminal' : 'unknown',
        canStop: manageable && running,
        // Une unité transitoire arrêtée est déchargée par systemd : elle ne revient
        // jamais dans la liste inactive, seule une unité en échec reste relançable.
        canRestart: manageable && entry.state !== 'deactivating',
        canReset: manageable && entry.state === 'failed',
      }]
    })
  }

  app.get('/api/services', async (request): Promise<ServicesDto> => {
    const user = requireUser(request)
    if (process.platform !== 'linux') return { supported: false, scannedAt: Date.now(), services: [], apps: [] }
    const [processes, apps] = await Promise.all([scan(), scanServiceApps(origins)])
    return {
      supported: true, scannedAt: cached!.at,
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
    cached = undefined
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
