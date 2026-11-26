import { and, eq } from 'drizzle-orm'
import { previewLabels, type ConversationRow, type UserRow } from '@sillage/db'
import { describePreviewBodySchema } from '@sillage/protocol'
import type { AppContext } from '../http/context.js'
import { previewTargets } from '../previews/targets.js'
import { Refusal } from './agent-requests-shared.js'

/**
 * `describe_preview`: how the session presents one of its dev servers in its thread. Allowed
 * before the server listens, so an agent can describe it right after starting it; refused when
 * another session's server holds the port.
 */
export async function describePreview(ctx: AppContext, conversation: ConversationRow, user: UserRow, payload: Record<string, unknown>): Promise<string> {
  const { port, title, show } = describePreviewBodySchema.parse(payload)
  const target = (await previewTargets(ctx, [ctx.config.server.port], user.id, user.isAdmin)).find((entry) => entry.port === port)
  if (target?.conversationId && target.conversationId !== conversation.id) {
    throw new Refusal(`Port ${port} is a dev server started by another session: describe only servers you started.`)
  }
  const key = and(eq(previewLabels.conversationId, conversation.id), eq(previewLabels.port, port))
  const previous = ctx.db.select().from(previewLabels).where(key).get()
  // Omitted fields keep their earlier value, so retitling does not unhide and hiding keeps the title.
  const row = { conversationId: conversation.id, port, title: title ?? previous?.title ?? null, hidden: show === undefined ? (previous?.hidden ?? false) : !show, updatedAt: Date.now() }
  ctx.db.insert(previewLabels).values(row).onConflictDoUpdate({ target: [previewLabels.conversationId, previewLabels.port], set: row }).run()
  const shown = row.hidden
    ? `Port ${port} is left out of the conversation thread; the user can still open it from the Preview tab.`
    : `Port ${port} is shown in the conversation thread${row.title ? ` as “${row.title}”` : ''}, with a button to open it.`
  return target?.conversationId === conversation.id ? shown : `${shown} Nothing you started listens there yet: this applies once it does.`
}
