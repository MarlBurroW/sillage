import { conversations, projects } from '@sillage/db'
import type { ServiceAppDto, ServiceDto } from '@sillage/protocol'
import type { AppContext } from '../http/context.js'
import { scanServiceApps, type ServiceApp } from './apps.js'
import { processOrigins, type ProcessOrigins } from './origins.js'
import { scanServiceProcesses, type ServiceProcess } from './processes.js'

export interface ServiceView {
  origins: ProcessOrigins
  /** Processes, from a cache of two seconds unless `fresh`. */
  scan: (fresh?: boolean) => Promise<ServiceProcess[]>
  scannedAt: () => number
  invalidate: () => void
  visible: (processes: ServiceProcess[], userId: string, isAdmin: boolean) => ServiceDto[]
  visibleApps: (apps: ServiceApp[], userId: string, isAdmin: boolean) => ServiceAppDto[]
  /** Both lists for one account, as the Services page and previews see them. */
  read: (userId: string, isAdmin: boolean) => Promise<{ services: ServiceDto[]; apps: ServiceAppDto[] }>
}

const views = new Map<string, ServiceView>()

/**
 * What runs because of Sillage, filtered to what an account may see. Shared by the Services routes
 * and dev previews, which may only proxy ports this view shows the account. One per data directory,
 * so both share the scan cache.
 */
export function serviceView(ctx: AppContext): ServiceView {
  const existing = views.get(ctx.config.paths.data)
  if (existing) return existing
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

  /** Origin project and conversation, or null when the user must not see it: another user's private project, or unknown origins for non-administrators. */
  const attribution = (userId: string, isAdmin: boolean) => {
    const allProjects = ctx.db.select().from(projects).all()
    const allConversations = new Map(ctx.db.select({
      id: conversations.id, userId: conversations.userId, projectId: conversations.projectId, title: conversations.title,
    }).from(conversations).all().map((row) => [row.id, row]))
    return (origin: ServiceProcess['origin']) => {
      if (origin?.projectId === null && origin.userId) {
        if (origin.userId !== userId) return null
        const conversation = origin.conversationId ? allConversations.get(origin.conversationId) : null
        return { project: null, conversation: conversation ?? null, personal: true }
      }
      const personal = origin?.conversationId && allConversations.get(origin.conversationId)
      if (personal && personal.projectId === null) return personal.userId === userId ? { project: null, conversation: personal } : null
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
        // Control launchers through their conversation or terminal. Stopping agent tools
        // (MCP servers) here would break conversations without freeing useful resources.
        canStop: !!entry.origin && (!!project || !!linked || Boolean(seen.personal)) && (entry.kind === 'command' || entry.kind === 'detached'),
      }]
    })
  }

  /** Apps follow process visibility, except administrators may also control apps with unknown origins. The `sillage-app-` prefix explicitly declares that Sillage may stop them, and administrators already control machine units. Forgetting to pass an origin token must not leave an app impossible to stop through the interface. */
  const visibleApps = (apps: ServiceApp[], userId: string, isAdmin: boolean): ServiceAppDto[] => {
    const attribute = attribution(userId, isAdmin)
    return apps.flatMap((entry): ServiceAppDto[] => {
      const seen = attribute(entry.origin)
      if (!seen) return []
      const { project, conversation } = seen
      const manageable = !!project || !!conversation || seen.personal || isAdmin
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
        // Stopped transient units are unloaded by systemd and never appear in the inactive
        // list again; only failed units remain restartable.
        canRestart: manageable && entry.state !== 'deactivating',
        canReset: manageable && entry.state === 'failed',
      }]
    })
  }


  const view: ServiceView = {
    origins,
    scan,
    scannedAt: () => cached?.at ?? Date.now(),
    invalidate: () => { cached = undefined },
    visible,
    visibleApps,
    read: async (userId, isAdmin) => {
      const [processes, apps] = await Promise.all([scan(), scanServiceApps(origins)])
      return { services: visible(processes, userId, isAdmin), apps: visibleApps(apps, userId, isAdmin) }
    },
  }
  views.set(ctx.config.paths.data, view)
  return view
}
