import { sql } from 'drizzle-orm'
import type { Db } from '@sillage/db'

/** Full-text message search index. Derived from the journal, never authoritative (invariant I2): rebuild by clearing and replaying when indexed content changes. One SQL extraction handles arriving messages, forked history and full rebuilds so migration backfill and live writes cannot diverge. */
const EXTRACT = sql`
  INSERT INTO search_messages (text, conversation_id, seq, role, ts)
  SELECT group_concat(block.value ->> '$.text', char(10)),
         event.conversation_id,
         event.seq,
         event.payload ->> '$.role',
         event.ts
  FROM events AS event, json_each(event.payload ->> '$.blocks') AS block
  WHERE event.type = 'message.completed'
    AND block.value ->> '$.type' = 'text'
    -- Les messages de sous-agents se lisent dans le panneau, pas dans le fil : ils
    -- n'ont donc aucune position où défiler, et un résultat de recherche qui y
    -- mènerait n'aurait nulle part où atterrir. Le coalesce garde les événements
    -- d'avant le champ, qui restent des lignes du fil principal.
    AND coalesce(event.payload ->> '$.parentToolCallId', '') = ''
`

/** Drizzle client or transaction writer: both execute SQL. */
type Runner = Pick<Db, 'run'>

/** Indexes newly journaled messages inside the journal write transaction so indexes cannot contain absent messages. Messages without text, such as tool-only calls, produce no rows because `GROUP BY` sees nothing. */
export function indexMessage(run: Runner, conversationId: string, seq: number): void {
  run.run(sql`${EXTRACT} AND event.conversation_id = ${conversationId} AND event.seq = ${seq}
    GROUP BY event.conversation_id, event.seq`)
}

/** Indexes an entire conversation after fork journal copying. */
export function indexConversation(run: Runner, conversationId: string): void {
  run.run(sql`${EXTRACT} AND event.conversation_id = ${conversationId}
    GROUP BY event.conversation_id, event.seq`)
}

export function dropConversation(run: Runner, conversationId: string): void {
  run.run(sql`DELETE FROM search_messages WHERE conversation_id = ${conversationId}`)
}

/** Full rebuild. Remove orphaned rows too: virtual FTS5 tables do not receive `ON DELETE CASCADE`, so project deletion leaves indexed messages. Search already hides them by joining conversations, but they occupy space until rebuilt. */
export function rebuild(db: Db): number {
  db.run(sql`DELETE FROM search_messages`)
  db.run(sql`${EXTRACT} GROUP BY event.conversation_id, event.seq`)

  const row = db.get<{ total: number }>(sql`SELECT count(*) AS total FROM search_messages`)
  return row?.total ?? 0
}
