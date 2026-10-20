import { randomUUID } from 'node:crypto'
import { and, eq, inArray, max, or, isNull, ne } from 'drizzle-orm'
import { cardNotes, cards, conversations, worktrees, type Db, type ProjectRow } from '@sillage/db'
import type { WorktreeStatusDto, WorktreeStatusListDto } from '@sillage/protocol'
import type { WorktreeStatusService } from './status-service.js'

/** Les colonnes d'où une fusion fait passer une carte en « Terminé ». */
const OPEN_COLUMNS = ['in_progress', 'review'] as const

/**
 * Passe en « Terminé » les cartes dont le worktree vient d'être fusionné.
 *
 * Branché sur les calculs d'avancement, comme la proposition de nettoyage : une fusion
 * se fait par l'onglet Git, par un agent au shell ou sur la forge puis un pull, et seul
 * l'état de l'arbre les voit toutes. Une carte encore à faire n'est pas touchée (rien
 * n'y a été lancé, ou quelqu'un l'y a remise), ni une carte déjà terminée ou abandonnée.
 * Pour une carte qui suit une issue GitHub, la synchronisation ferme ensuite l'issue,
 * comme le ferait un « Fixes #n » dans le commit.
 */
export function watchMergedCards(db: Db, status: WorktreeStatusService): void {
  status.onComputed((project, list) => {
    closeMergedCards(db, project, list)
  })
}

/** Exporté pour les tests : un passage, sur une liste d'avancement donnée. */
export function closeMergedCards(db: Db, project: ProjectRow, list: WorktreeStatusListDto): number {
  if (!list.base) return 0
  let closed = 0
  for (const tree of list.worktrees) {
    // L'arbre qui porte la branche par défaut n'est pas un chantier qu'on fusionne.
    if (tree.state !== 'merged' || tree.branch === list.base) continue
    const ids = tree.conversations.map((entry) => entry.id)
    if (ids.length === 0) continue

    const linked = db
      .select({ status: conversations.status, cardId: conversations.cardId, createdAt: conversations.createdAt })
      .from(conversations)
      .where(inArray(conversations.id, ids))
      .all()
    // Une session qui travaille encore dans l'arbre n'a peut-être pas fini.
    if (linked.some((row) => row.status === 'running' || row.status === 'awaiting_input')) continue
    if (!hasOwnWork(db, tree, linked)) continue

    const cardIds = [...new Set(linked.map((row) => row.cardId).filter((id): id is string => id !== null))]
    if (cardIds.length === 0) continue
    const targets = db
      .select({ id: cards.id })
      .from(cards)
      .where(
        and(
          eq(cards.projectId, project.id),
          inArray(cards.id, cardIds),
          inArray(cards.column, [...OPEN_COLUMNS]),
          // Une seule fois par arbre : la carte ramenée en cours à la main y reste.
          or(isNull(cards.doneByMerge), ne(cards.doneByMerge, tree.path)),
        ),
      )
      .all()

    for (const { id } of targets) {
      const now = Date.now()
      db.transaction((tx) => {
        const { last } = tx
          .select({ last: max(cards.position) })
          .from(cards)
          .where(and(eq(cards.projectId, project.id), eq(cards.column, 'done')))
          .get() ?? { last: null }
        tx.update(cards)
          .set({ column: 'done', position: (last ?? 0) + 1, doneByMerge: tree.path, updatedAt: now })
          .where(eq(cards.id, id))
          .run()
        // Une ligne dans l'activité : sans elle, une carte qui change de colonne seule
        // ressemble à une erreur.
        tx.insert(cardNotes)
          .values({
            id: randomUUID(),
            cardId: id,
            conversationId: null,
            userId: null,
            body: `Passée en « Terminé » : la branche \`${tree.branch ?? tree.name}\` est fusionnée dans \`${list.base}\`.`,
            createdAt: now,
            publication: null,
          })
          .run()
      })
      closed += 1
    }
  }
  return closed
}

/**
 * L'arbre a-t-il porté du travail à lui ? Un worktree fraîchement créé, sans commit,
 * est lui aussi « fusionné » : sa tête est déjà dans la base. Le signe d'un vrai
 * travail est un dernier commit postérieur à la naissance de l'arbre (sa ligne en base
 * pour un arbre de Sillage, sa première session pour un arbre créé au shell).
 */
function hasOwnWork(db: Db, tree: WorktreeStatusDto, linked: { createdAt: number }[]): boolean {
  if (tree.lastCommitAt === null) return false
  const row = tree.id
    ? db.select({ createdAt: worktrees.createdAt }).from(worktrees).where(eq(worktrees.id, tree.id)).get()
    : undefined
  const born = row?.createdAt ?? Math.min(...linked.map((entry) => entry.createdAt))
  return tree.lastCommitAt > born
}
