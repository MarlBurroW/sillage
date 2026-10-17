import { and, eq, isNull } from 'drizzle-orm'
import { conversationPaths, worktrees, type Db } from '@sillage/db'

/**
 * Les worktrees Sillage où une session travaille sans y avoir son cwd : ceux qu'elle a
 * créés par `create_worktree`, ou dans lesquels elle a écrit.
 *
 * Ils s'ajoutent aux dossiers que le CLI peut écrire : sans cela, une session en mode
 * restreint (Codex en `workspace-write`, Claude hors contournement des permissions) se
 * verrait refuser les écritures dans l'arbre qu'on vient de lui créer. Lu à chaque appel,
 * pour qu'un arbre créé en cours de session compte dès le tour suivant chez Codex.
 */
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
