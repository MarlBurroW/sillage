import { eq } from 'drizzle-orm'
import { conversations, type Db } from '@sillage/db'
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
  db.delete(conversations).where(eq(conversations.id, id)).run()
}
