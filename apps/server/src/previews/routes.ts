import type { FastifyInstance } from 'fastify'
import { openPreviewBodySchema, type PreviewListDto, type PreviewOpenDto, type PreviewTargetDto } from '@sillage/protocol'
import type { AppContext } from '../http/context.js'
import { HttpError } from '../http/errors.js'
import { requireUser } from '../http/require-user.js'
import { INSTANCE_PROFILE } from '../instance/profile.js'
import { serviceView } from '../services/visible.js'
import type { PreviewService } from './service.js'

export function registerPreviewRoutes(app: FastifyInstance, ctx: AppContext, previews: PreviewService | null): void {
  const view = serviceView(ctx)
  const desktop = INSTANCE_PROFILE === 'desktop'

  /**
   * Ports the account may preview: those Services shows it, from commands and apps (not the CLIs
   * themselves nor their tools), minus Sillage's own listeners.
   */
  const targets = async (userId: string, isAdmin: boolean): Promise<PreviewTargetDto[]> => {
    if (process.platform !== 'linux') return []
    const own = new Set([ctx.config.server.port, previews?.listenerPort])
    const { services, apps } = await view.read(userId, isAdmin)
    const found = new Map<number, PreviewTargetDto>()
    for (const entry of apps) {
      for (const port of entry.ports) {
        if (!own.has(port)) found.set(port, { port, label: entry.description || entry.executable || entry.unit, command: entry.command, projectId: entry.projectId, conversationId: entry.conversationId, conversationTitle: entry.conversationTitle })
      }
    }
    for (const entry of services) {
      if (entry.kind !== 'command' && entry.kind !== 'detached') continue
      for (const port of entry.ports) {
        if (!own.has(port) && !found.has(port)) found.set(port, { port, label: entry.name, command: entry.command, projectId: entry.projectId, conversationId: entry.conversationId, conversationTitle: entry.conversationTitle })
      }
    }
    return [...found.values()].sort((a, b) => a.port - b.port)
  }

  app.get('/api/previews', async (request): Promise<PreviewListDto> => {
    const user = requireUser(request)
    const domain = previews?.domain() ?? ''
    return {
      mode: desktop ? 'direct' : domain ? 'proxy' : 'unconfigured',
      domain,
      listenerPort: previews?.listenerPort ?? null,
      targets: await targets(user.id, user.isAdmin),
    }
  })

  app.post('/api/previews', async (request): Promise<PreviewOpenDto> => {
    const user = requireUser(request)
    const { port } = openPreviewBodySchema.parse(request.body)
    // Desktop's single account owns the machine, and discovery is Linux-only: any local port goes,
    // straight to loopback, which is already another origin than Sillage.
    if (desktop) {
      const address = `http://127.0.0.1:${port}/`
      return { url: address, address }
    }
    if (!previews?.domain()) throw new HttpError(409, 'previews_unconfigured', 'An administrator must set a preview domain first.')
    // Only ports this account sees in Services: never Sillage itself, another account's private
    // project, or whatever else listens on the machine.
    if (!(await targets(user.id, user.isAdmin)).some((target) => target.port === port)) {
      throw new HttpError(404, 'preview_target_unknown', 'Nothing of yours listens on this port.')
    }
    return previews.open(user.id, port, request.protocol === 'https')
  })
}
