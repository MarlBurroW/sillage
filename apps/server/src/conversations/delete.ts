import { and, eq, isNull } from 'drizzle-orm'
import { conversations, sessionMessages, sessionWatches, type Db } from '@sillage/db'
import type { AttachmentStore } from '../attachments/store.js'
import { dropConversation } from '../search/search-index.js'
import type { SessionManager } from '../sessions/session-manager.js'

/**
 * Removes a conversation and everything the database cascade cannot reach. Shared by the
 * interface route and benchmark deletion: a second copy would forget a step the first learned.
 */
export async function deleteConversation(
  db: Db,
  sessions: SessionManager,
  attachments: AttachmentStore,
  id: string,
): Promise<void> {
  await sessions.terminate(id)
  // Remove git snapshots first while the row still identifies the repository.
  await sessions.dropCheckpoints(id)
  // Remove files first: database cascades only delete rows.
  await attachments.removeForConversations([id])
  // The search index is a virtual table, unreachable by cascades.
  dropConversation(db, id)
  settleMailbox(db, id)
  db.delete(conversations).where(eq(conversations.id, id)).run()
}

/**
 * Mailbox rows name conversations without a foreign key: the MCP server writes them from another
 * process. Left open, the relay would keep trying to journal into a thread that no longer exists.
 * Messages to the deleted session end as failed deliveries, still readable by their senders;
 * watches it held are closed. Watches on it stay open: the relay tells their watchers it is gone.
 */
function settleMailbox(db: Db, id: string): void {
  const now = Date.now()
  db.update(sessionMessages)
    .set({ heldAt: null })
    .where(eq(sessionMessages.toConversationId, id))
    .run()
  db.update(sessionMessages)
    .set({ deliveredAt: now, deliveredVia: 'failed' })
    .where(and(eq(sessionMessages.toConversationId, id), isNull(sessionMessages.deliveredAt)))
    .run()
  db.update(sessionWatches)
    .set({ firedAt: now })
    .where(and(eq(sessionWatches.watcherConversationId, id), isNull(sessionWatches.firedAt)))
    .run()
}
