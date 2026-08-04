import { and, eq, exists, gte, isNull, lt, or, sql } from 'drizzle-orm'
import { conversationReads, conversations, type Db } from '@sillage/db'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Range les fils qu'on a fini de lire et qu'on ne rouvre plus.
 *
 * Une action manuelle ne suffisait pas : la sidebar déborde par négligence, pas par
 * choix, et une entrée de menu ignorée l'aurait été autant que la suppression qu'elle
 * remplace. Le rangement doit donc se faire tout seul.
 *
 * D'où des critères stricts, chacun répondant à une façon de ranger à tort :
 *
 * - épinglé, jamais. `pinned` devient le « ne touche pas à celui-là » explicite ;
 * - `running` ou `awaiting_input`, jamais : un agent qui travaille ou qui attend une
 *   réponse ne doit pas disparaître de la vue de qui doit la lui donner ;
 * - travaux de fond ou boucles en cours, jamais. Le statut retombe à la fin du tour et
 *   non à la fin du travail, donc `idle` seul ne prouve pas qu'il ne se passe plus rien ;
 * - jamais rattrapé par son propriétaire, jamais. Cacher ce que personne n'a lu, c'est
 *   perdre le travail plutôt que le ranger. Le curseur est celui du propriétaire et non
 *   de tous les lecteurs : dans un projet partagé, un compte qui ne passe jamais
 *   maintiendrait sinon tous les fils en vie indéfiniment.
 *
 * Renvoie le nombre de conversations rangées.
 */
export function archiveStaleConversations(db: Db, afterDays: number): number {
  const now = Date.now()

  const ownerCaughtUp = exists(
    db
      .select({ one: sql`1` })
      .from(conversationReads)
      .where(
        and(
          eq(conversationReads.conversationId, conversations.id),
          eq(conversationReads.userId, conversations.userId),
          gte(conversationReads.lastReadSeq, conversations.lastSeq),
        ),
      ),
  )

  const result = db
    .update(conversations)
    .set({ archivedAt: now })
    .where(
      and(
        isNull(conversations.archivedAt),
        eq(conversations.pinned, false),
        or(eq(conversations.status, 'idle'), eq(conversations.status, 'interrupted')),
        eq(conversations.backgroundCount, 0),
        eq(conversations.loopCount, 0),
        lt(conversations.updatedAt, now - afterDays * DAY_MS),
        ownerCaughtUp,
      ),
    )
    .run()

  return result.changes
}
