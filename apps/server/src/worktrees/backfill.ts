import { eq, sql } from 'drizzle-orm'
import { appSettings, conversationPaths, writeTransaction, type Db } from '@sillage/db'
import { touchedPaths } from '../events/touched-paths.js'

const MARKER = 'worktree_paths_backfill'

/**
 * Commandes lues par lot. Le daemon tourne avec un tas de 256 Mo et le journal de
 * marldev en garde plus de cent mille, soit 70 Mo de texte : tout charger d'un coup au
 * démarrage risquait la panne de mémoire.
 */
const BATCH = 2000

/**
 * Rattrapage unique des dossiers cités par les commandes Bash déjà journalisées.
 *
 * La migration 0044 reprend les éditions à chemin absolu, que SQL sait extraire ; les
 * commandes, elles, demandent les expressions de `touched-paths.ts`, d'où ce passage en
 * TypeScript au premier démarrage, marqué dans `app_settings` pour ne pas se rejouer.
 *
 * Par lots, avec un curseur sur la clé primaire du journal : un seul parcours de la
 * table, une mémoire bornée par lot. Chaque lot s'écrit dans sa transaction ; un arrêt
 * au milieu reprend au début au démarrage suivant, sans dommage puisque l'écriture est
 * idempotente. Quelques secondes sur cent mille commandes, une fois.
 */
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
