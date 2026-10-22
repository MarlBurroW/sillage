import { and, eq, isNull } from 'drizzle-orm'
import { conversationPaths, worktrees, type Db } from '@sillage/db'

/** Sillage worktrees a session uses outside its cwd, either created through `create_worktree` or written into. Add them to CLI writable directories so restricted sessions (Codex `workspace-write`, Claude without permission bypass) can edit newly created trees. Reread each call so worktrees created mid-session apply to Codex's next turn. */
export function linkedWorktreePaths(db: Db, conversationId: string, projectId: string): string[] {
  const trees = db
    .select({ path: worktrees.path })
    .from(worktrees)
    .where(and(eq(worktrees.projectId, projectId), isNull(worktrees.removedAt)))
    .all()
  if (trees.length === 0) return []

  const touched = db
    .select({ path: conversationPaths.path })
    .from(conversationPaths)
    .where(eq(conversationPaths.conversationId, conversationId))
    .all()
    .map((row) => row.path)
  return trees
    .map((tree) => tree.path)
    .filter((path) => touched.some((entry) => entry === path || entry.startsWith(`${path}/`)))
}
