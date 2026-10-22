import type { EventEmitter } from 'node:events'
import { and, eq, ne, or } from 'drizzle-orm'
import { conversations, type Db } from '@sillage/db'

/** Conditional writes protect human edits made while a CLI is asynchronously generating its summary. */
export function adoptSessionTitle(
  db: Db,
  bus: Pick<EventEmitter, 'emit'>,
  conversationId: string,
  title: string,
  source: 'agent' | 'cli',
): 'updated' | 'unchanged' | 'protected' | 'missing' {
  const changed = db.update(conversations)
    .set({ title, ...(source === 'agent' ? { titleSetByAgent: true } : {}) })
    .where(and(
      eq(conversations.id, conversationId),
      eq(conversations.titleSetByUser, false),
      source === 'cli' ? eq(conversations.titleSetByAgent, false) : undefined,
      or(ne(conversations.title, title), source === 'agent' ? eq(conversations.titleSetByAgent, false) : undefined),
    ))
    .returning({ id: conversations.id })
    .get()
  if (changed) {
    bus.emit('title', { conversationId, title })
    return 'updated'
  }
  const current = db.select({ user: conversations.titleSetByUser, agent: conversations.titleSetByAgent })
    .from(conversations).where(eq(conversations.id, conversationId)).get()
  if (!current) return 'missing'
  return current.user || (source === 'cli' && current.agent) ? 'protected' : 'unchanged'
}
