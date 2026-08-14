import type { Db } from '@sillage/db'
import { conversationWorkspace, projectWorkspace } from '../../workspace.js'

/**
 * Les routes du panneau (arborescence, fichiers, git) existent en deux portées : par
 * conversation, où le répertoire est celui du fil, worktree compris, et par projet, où
 * c'est le workspace. Même logique, même contrôle d'accès, seul le résolveur change :
 * chaque module les enregistre en boucle sur cette liste plutôt qu'en deux copies.
 */
export interface WorkspaceScope {
  base: string
  cwdOf(db: Db, id: string, userId: string): string
}

export const workspaceScopes: readonly WorkspaceScope[] = [
  { base: '/api/conversations/:id', cwdOf: conversationWorkspace },
  { base: '/api/projects/:id', cwdOf: projectWorkspace },
]
