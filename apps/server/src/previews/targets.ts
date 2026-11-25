import type { PreviewTargetDto } from '@sillage/protocol'
import type { AppContext } from '../http/context.js'
import { serviceView } from '../services/visible.js'

/**
 * Ports an account may preview: those Services shows it, from commands and apps (not the CLIs
 * themselves nor their tools), minus Sillage's own listeners. Shared by the routes, which check a
 * port before opening or sharing it, and by the listener, which re-checks public links.
 */
export async function previewTargets(ctx: Pick<AppContext, 'db' | 'config'>, ownPorts: number[], userId: string, isAdmin: boolean): Promise<PreviewTargetDto[]> {
  if (process.platform !== 'linux') return []
  const own = new Set(ownPorts)
  const { services, apps } = await serviceView(ctx).read(userId, isAdmin)
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
