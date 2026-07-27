import { sql } from 'drizzle-orm'
import type { Db } from '@sillage/db'

/**
 * Index de recherche plein texte sur les messages.
 *
 * Table dérivée du journal, jamais consultée comme source (invariant I2) : elle se
 * vide et se reconstruit par rejeu, et le jour où le contenu indexé changera, c'est ce
 * chemin qui rattrapera l'existant.
 *
 * Une seule extraction, partagée par les trois usages (un message qui arrive, un fil
 * copié par fork, une reconstruction complète). Écrite en SQL et non en TypeScript
 * pour que la reprise dans la migration et l'écriture à chaud ne puissent pas diverger.
 */
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
`

/** Écriture d'un client Drizzle ou d'une transaction : les deux savent exécuter du SQL. */
type Runner = Pick<Db, 'run'>

/**
 * Indexe le message qui vient d'être journalisé.
 *
 * Appelé dans la transaction d'écriture du journal, donc l'index ne peut pas contenir
 * un message que le journal n'aurait pas. Un message sans bloc de texte, par exemple
 * un appel d'outil seul, ne produit aucune ligne : le `GROUP BY` ne voit rien.
 */
export function indexMessage(run: Runner, conversationId: string, seq: number): void {
  run.run(sql`${EXTRACT} AND event.conversation_id = ${conversationId} AND event.seq = ${seq}
    GROUP BY event.conversation_id, event.seq`)
}

/** Indexe un fil entier, après la copie de journal que fait un fork. */
export function indexConversation(run: Runner, conversationId: string): void {
  run.run(sql`${EXTRACT} AND event.conversation_id = ${conversationId}
    GROUP BY event.conversation_id, event.seq`)
}

export function dropConversation(run: Runner, conversationId: string): void {
  run.run(sql`DELETE FROM search_messages WHERE conversation_id = ${conversationId}`)
}

/**
 * Reconstruction complète.
 *
 * Les lignes orphelines partent avec le reste : une table virtuelle FTS5 ne reçoit pas
 * les `ON DELETE CASCADE`, donc supprimer un projet laisse derrière lui les messages
 * de ses conversations. La requête de recherche les ignore déjà, en joignant les
 * conversations, mais ils occupent de la place jusqu'ici.
 */
export function rebuild(db: Db): number {
  db.run(sql`DELETE FROM search_messages`)
  db.run(sql`${EXTRACT} GROUP BY event.conversation_id, event.seq`)

  const row = db.get<{ total: number }>(sql`SELECT count(*) AS total FROM search_messages`)
  return row?.total ?? 0
}
