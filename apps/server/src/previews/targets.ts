import type { PreviewTargetDto, StoppedPreviewDto } from '@sillage/protocol'
import { previewLabels } from '@sillage/db'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
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
      if (!own.has(port)) found.set(port, { port, label: entry.description || entry.executable || entry.unit, command: entry.command, projectId: entry.projectId, conversationId: entry.conversationId, conversationTitle: entry.conversationTitle, title: null, path: null, hidden: false, address: null })
    }
  }
  for (const entry of services) {
    if (entry.kind !== 'command' && entry.kind !== 'detached') continue
    for (const port of entry.ports) {
      if (!own.has(port) && !found.has(port)) found.set(port, { port, label: entry.name, command: entry.command, projectId: entry.projectId, conversationId: entry.conversationId, conversationTitle: entry.conversationTitle, title: null, path: null, hidden: false, address: null })
    }
  }
  // What each conversation's agent said about its own servers (`describe_preview`). A label only
  // applies to the conversation that wrote it: another session's server on the same port is not it.
  const conversationIds = [...new Set([...found.values()].flatMap((target) => target.conversationId ?? []))]
  if (conversationIds.length > 0) {
    const labels = ctx.db.select().from(previewLabels).where(inArray(previewLabels.conversationId, conversationIds)).all()
    for (const label of labels) {
      const target = found.get(label.port)
      if (target?.conversationId === label.conversationId) Object.assign(target, { title: label.title, path: label.path, hidden: label.hidden })
    }
  }
  return [...found.values()].sort((a, b) => a.port - b.port)
}

/**
 * Marks the conversations' listening servers as seen, so they leave a "stopped" line in the thread
 * once they stop. Only the first sighting writes: lists are polled every few seconds.
 */
export function recordSeen(ctx: Pick<AppContext, 'db'>, targets: PreviewTargetDto[]): void {
  const now = Date.now()
  for (const target of targets) {
    if (!target.conversationId) continue
    try {
      ctx.db.insert(previewLabels).values({ conversationId: target.conversationId, port: target.port, seenAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: [previewLabels.conversationId, previewLabels.port], set: { seenAt: now }, setWhere: sql`${previewLabels.seenAt} IS NULL` })
        .run()
    } catch { /* The conversation was deleted between the scan and now. */ }
  }
}

/**
 * Servers the conversation ran and titled with describe_preview, listening or not: the thread tells
 * them apart. Untitled ones are left out: agents start many throwaway servers (renderers, test
 * fixtures, helpers on ephemeral ports), and a line for each buried the one the user cared about.
 */
export function seenPreviews(ctx: Pick<AppContext, 'db'>, conversationId: string): StoppedPreviewDto[] {
  const rows = ctx.db.select({ port: previewLabels.port, title: previewLabels.title }).from(previewLabels)
    .where(and(eq(previewLabels.conversationId, conversationId), isNotNull(previewLabels.seenAt), isNotNull(previewLabels.title), eq(previewLabels.hidden, false)))
    .orderBy(previewLabels.port).all()
  return rows.flatMap((row) => (row.title ? [{ port: row.port, title: row.title }] : []))
}
