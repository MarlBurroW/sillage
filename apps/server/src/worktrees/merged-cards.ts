import { randomUUID } from 'node:crypto'
import { and, eq, inArray, max, or, isNull, ne } from 'drizzle-orm'
import { cardNotes, cards, conversations, worktrees, type Db, type ProjectRow } from '@sillage/db'
import type { WorktreeStatusDto, WorktreeStatusListDto } from '@sillage/protocol'
import type { WorktreeStatusService } from './status-service.js'

/** Columns from which merges move cards to 'Done'. */
const OPEN_COLUMNS = ['in_progress', 'review'] as const

/** Moves cards to 'Done' when their worktree has just merged. Driven by progress assessments: merges may happen through the Git tab, agent shells or remote merges followed by pull, and only worktree state captures every path. Leave todo cards untouched (nothing started, or deliberately moved back), as well as completed or abandoned cards. For GitHub-linked cards, synchronization then closes the issue like a 'Fixes #n' commit would. */
export function watchMergedCards(db: Db, status: WorktreeStatusService): void {
  status.onComputed((project, list) => {
    closeMergedCards(db, project, list)
  })
}

/** Exported for tests: one pass over a supplied progress list. */
export function closeMergedCards(db: Db, project: ProjectRow, list: WorktreeStatusListDto): number {
  if (!list.base) return 0
  let closed = 0
  for (const tree of list.worktrees) {
    // The default-branch worktree is not work awaiting merge.
    if (tree.state !== 'merged' || tree.branch === list.base) continue
    const ids = tree.conversations.map((entry) => entry.id)
    if (ids.length === 0) continue

    const linked = db
      .select({ status: conversations.status, cardId: conversations.cardId, createdAt: conversations.createdAt })
      .from(conversations)
      .where(inArray(conversations.id, ids))
      .all()
    // Sessions still working in the tree may not be finished.
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
          // Once per tree: manually moved-back cards stay in progress.
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
        // Record activity: cards changing columns on their own
        // would otherwise look like errors.
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

/** Has this worktree held its own work? Newly created trees without commits also appear merged because their tip is already in the base. Real work requires the latest commit to postdate creation: the database row for Sillage trees, or first session for shell-created trees. */
function hasOwnWork(db: Db, tree: WorktreeStatusDto, linked: { createdAt: number }[]): boolean {
  if (tree.lastCommitAt === null) return false
  const row = tree.id
    ? db.select({ createdAt: worktrees.createdAt }).from(worktrees).where(eq(worktrees.id, tree.id)).get()
    : undefined
  const born = row?.createdAt ?? Math.min(...linked.map((entry) => entry.createdAt))
  return tree.lastCommitAt > born
}
