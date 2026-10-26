import { and, eq, isNull, or } from 'drizzle-orm'
import { conversations, projects, type Db } from '@sillage/db'
import { notFound } from '../http/errors.js'

/** Apply after a LEFT JOIN on projects: a personal discussion is visible only to its account. */
export function readableConversationFilter(userId: string) {
  return or(
    and(isNull(conversations.projectId), eq(conversations.userId, userId)),
    eq(projects.ownerId, userId),
    eq(projects.visibility, 'shared'),
  )
}

export function readableConversation(db: Db, id: string, userId: string) {
  const row = db.select({ conversation: conversations }).from(conversations)
    .leftJoin(projects, eq(projects.id, conversations.projectId))
    .where(and(eq(conversations.id, id), readableConversationFilter(userId))).get()
  if (!row) throw notFound('conversation_not_found', 'Conversation not found.')
  return row.conversation
}
