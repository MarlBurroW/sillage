import { eq, sql } from 'drizzle-orm'
import { appSettings, conversationPaths, writeTransaction, type Db } from '@sillage/db'
import { touchedPaths } from '../events/touched-paths.js'

const MARKER = 'worktree_paths_backfill'

/** Read commands in batches. The daemon has a 256 MB heap and marldev retains over a hundred thousand commands totaling 70 MB: loading them all at startup risked running out of memory. */
const BATCH = 2000

/** One-time backfill of directories referenced by already-journaled Bash commands. Migration 0044 extracts absolute-path edits through SQL, but commands require `touched-paths.ts` expressions, hence this first-start TypeScript pass marked in `app_settings`. Batch with a journal primary-key cursor for one traversal and bounded memory. Each batch has its own transaction; interruptions restart safely from the beginning because writes are idempotent. Runs once, taking a few seconds for a hundred thousand commands. */
export function backfillCommandPaths(db: Db, batch = BATCH): number {
  const done = db.select().from(appSettings).where(eq(appSettings.key, MARKER)).get()
  if (done) return 0

  let written = 0
  let cursor: { conversationId: string; seq: number } = { conversationId: '', seq: -1 }
  for (;;) {
    const rows = db.all<{ conversationId: string; seq: number; ts: number; command: string | null }>(sql`
      SELECT conversation_id AS conversationId, seq, ts, payload ->> '$.input.command' AS command
      FROM events
      WHERE (conversation_id, seq) > (${cursor.conversationId}, ${cursor.seq})
        AND type = 'tool.started' AND payload ->> '$.name' = 'Bash'
      ORDER BY conversation_id, seq
      LIMIT ${batch}
    `)
    if (rows.length === 0) break

    writeTransaction(db, (tx) => {
      for (const row of rows) {
        if (typeof row.command !== 'string') continue
        const found = touchedPaths({ type: 'tool.started', toolCallId: '', name: 'Bash', input: { command: row.command }, parentToolCallId: null })
        for (const path of found) {
          tx.insert(conversationPaths)
            .values({ conversationId: row.conversationId, path, lastTs: row.ts })
            .onConflictDoUpdate({
              target: [conversationPaths.conversationId, conversationPaths.path],
              set: { lastTs: sql`max(${conversationPaths.lastTs}, ${row.ts})` },
            })
            .run()
          written += 1
        }
      }
    })
    const last = rows[rows.length - 1]!
    cursor = { conversationId: last.conversationId, seq: last.seq }
  }

  db.insert(appSettings).values({ key: MARKER, value: '1', updatedAt: Date.now() }).run()
  return written
}
