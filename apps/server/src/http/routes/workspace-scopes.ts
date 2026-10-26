import { personalWorkspace } from '../../conversations/personal-workspaces.js'
import type { Db } from '@sillage/db'
import { conversationWorkspace, projectWorkspace } from '../../workspace.js'

/**
 * Panel routes (tree, files, git) have two scopes: conversations use their own
 * directory, including worktrees; projects use the workspace. Logic and access
 * checks are shared; only the resolver differs. Each module registers routes
 * over this list instead of maintaining duplicate implementations.
 */
export interface WorkspaceScope {
  base: string
  cwdOf(db: Db, id: string, userId: string): string
}

export const workspaceScopes: readonly WorkspaceScope[] = [
  { base: '/api/conversations/:id', cwdOf: conversationWorkspace },
  { base: '/api/projects/:id', cwdOf: projectWorkspace },
  { base: '/api/personal-workspaces/:id', cwdOf: (db, id, userId) => personalWorkspace(db, id, userId).path },
]
