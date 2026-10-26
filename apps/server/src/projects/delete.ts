import { eq } from 'drizzle-orm'
import { cards, conversations, projects } from '@sillage/db'
import type { AttachmentStore } from '../attachments/store.js'
import type { AppContext } from '../http/context.js'
import { forbidden, notFound } from '../http/errors.js'
import { dropConversation } from '../search/search-index.js'
import type { SessionManager } from '../sessions/session-manager.js'
import { SkillLibrary } from '../skill-library/store.js'
import type { TerminalManager } from '../terminals/terminal-manager.js'

/** UI and assistant deletion share ownership checks and cleanup; the workspace is never removed. */
export async function deleteProject(ctx: AppContext, id: string, userId: string, attachments: AttachmentStore, terminals: TerminalManager, sessions?: SessionManager): Promise<void> {
  const project = ctx.db.select().from(projects).where(eq(projects.id, id)).get()
  if (!project) throw notFound('project_not_found', 'Project not found.')
  if (project.ownerId !== userId) throw forbidden('project_delete_forbidden', 'Only the owner can delete this project.')
  const owned = ctx.db.select({ id: conversations.id }).from(conversations).where(eq(conversations.projectId, id)).all()
  for (const row of owned) await sessions?.terminate(row.id)
  await attachments.removeForConversations(owned.map(row => row.id))
  const tickets = ctx.db.select({ id: cards.id }).from(cards).where(eq(cards.projectId, id)).all()
  await attachments.removeForCards(tickets.map(row => row.id))
  for (const row of owned) dropConversation(ctx.db, row.id)
  terminals.closeForProject(id)
  new SkillLibrary(ctx.db, ctx.config.paths.skillLibrary).removeProject(id)
  ctx.db.delete(projects).where(eq(projects.id, id)).run()
}
