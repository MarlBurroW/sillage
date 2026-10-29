import { eq } from 'drizzle-orm'
import { worktrees, type Db } from '@sillage/db'

/** Has this worktree held its own work? Newly created trees without commits also appear merged because their tip is already in the base. Real work requires the latest commit to postdate creation: the database row for Sillage trees, or first session for shell-created trees. */
export function hasOwnWork(
  db: Db,
  tree: { id: string | null; lastCommitAt: number | null },
  linked: { createdAt: number }[],
): boolean {
  if (tree.lastCommitAt === null) return false
  const row = tree.id
    ? db.select({ createdAt: worktrees.createdAt }).from(worktrees).where(eq(worktrees.id, tree.id)).get()
    : undefined
  const born = row?.createdAt ?? Math.min(...linked.map((entry) => entry.createdAt))
  return tree.lastCommitAt > born
}
