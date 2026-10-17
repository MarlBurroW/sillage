import { and, eq, exists, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { conversationReads, conversations, type Db } from '@sillage/db'
import { deleteCheckpoints } from '../checkpoints.js'
import type { Config } from '../config.js'
import { readAppSettings } from '../settings/app-settings.js'
import { resolveConversationCwd } from '../workspace.js'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Un passage complet, tel que la tâche planifiée et le bouton « lancer maintenant » le
 * font tous les deux. Renvoie le nombre de conversations rangées, ou `null` quand
 * l'archivage automatique est coupé.
 *
 * Le délai à zéro bloque aussi le déclenchement manuel : il vaudrait sinon « range tout
 * ce qui est lu et au repos, à l'instant », ce que personne ne demande en cliquant.
 */
export function runArchivePass(db: Db, config: Config): number | null {
  const { autoArchiveDays } = readAppSettings(db, config)
  if (autoArchiveDays === 0) return null

  return archiveStaleConversations(db, autoArchiveDays)
}

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

  // Les candidats sont lus avant d'être rangés : leurs captures git, elles, ne se
  // retrouvent qu'en sachant quelles lignes ont basculé.
  const stale = db
    .select({ id: conversations.id, projectId: conversations.projectId, worktreeId: conversations.worktreeId })
    .from(conversations)
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
    .all()
  if (stale.length === 0) return 0

  const result = db
    .update(conversations)
    .set({ archivedAt: now })
    .where(
      and(
        isNull(conversations.archivedAt),
        inArray(
          conversations.id,
          stale.map((row) => row.id),
        ),
      ),
    )
    .run()

  // Un fil rangé n'a plus de tour à défaire : ses captures quittent le dépôt, sans
  // retenir le passage, un dépôt absent ou lent n'ayant pas à le faire échouer.
  void (async () => {
    for (const row of stale) {
      try {
        await deleteCheckpoints(resolveConversationCwd(db, row), row.id)
      } catch {
        // Projet retiré du disque, dépôt hors d'usage : les refs partiront avec lui.
      }
    }
  })()

  return result.changes
}
