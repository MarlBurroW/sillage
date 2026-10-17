import { eq, sql } from 'drizzle-orm'
import { appSettings, conversationPaths, events, writeTransaction, type Db } from '@sillage/db'
import { touchedPaths } from '../events/touched-paths.js'

const MARKER = 'worktree_paths_backfill'

/**
 * Rattrapage unique des dossiers cités par les commandes Bash déjà journalisées.
 *
 * La migration 0044 reprend les éditions à chemin absolu, que SQL sait extraire ; les
 * commandes, elles, demandent les expressions de `touched-paths.ts`, d'où ce passage en
 * TypeScript au premier démarrage, marqué dans `app_settings` pour ne pas se rejouer.
 * Quelques secondes sur cent mille commandes, une fois.
 */
export function backfillCommandPaths(db: Db): number {
  const done = db.select().from(appSettings).where(eq(appSettings.key, MARKER)).get()
  if (done) return 0

  const rows = db
    .select({
      conversationId: events.conversationId,
      ts: events.ts,
      command: sql<string | null>`${events.payload} ->> '$.input.command'`,
    })
    .from(events)
    .where(sql`${events.type} = 'tool.started' AND ${events.payload} ->> '$.name' = 'Bash'`)
    .all()

  let written = 0
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
    tx.insert(appSettings).values({ key: MARKER, value: '1', updatedAt: Date.now() }).run()
  })
  return written
}
