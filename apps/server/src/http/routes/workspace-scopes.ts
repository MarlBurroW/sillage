import { and, eq } from 'drizzle-orm'
import { explorerFolders, projectFolders, projects, type Db } from '@sillage/db'
import type { TreeScope } from '@sillage/protocol'
import { personalWorkspace } from '../../conversations/personal-workspaces.js'
import { conversationWorkspace, projectWorkspace } from '../../workspace.js'
import { visibilityFilter } from './projects.js'
import { notFound } from '../errors.js'

interface WorkspaceScope {
  base: string
  cwdOf(db: Db, id: string, userId: string): string
}

/** Watches and HTTP routes must resolve the same account's directory for a scope. */
export const workspaceScope = {
  conversation: { base: '/api/conversations/:id', cwdOf: conversationWorkspace },
  project: { base: '/api/projects/:id', cwdOf: projectWorkspace },
  personal: { base: '/api/personal-workspaces/:id', cwdOf: (db, id, userId) => personalWorkspace(db, id, userId).path },
  'project-folder': {
    base: '/api/project-folders/:id',
    cwdOf(db, id, userId) {
      const row = db.select({ path: projectFolders.path }).from(projectFolders)
        .innerJoin(projects, eq(projects.id, projectFolders.projectId))
        .where(and(eq(projectFolders.id, id), visibilityFilter(userId))).get()
      if (!row) throw notFound('workspace_not_found', 'Directory not found.')
      return row.path
    },
  },
  folder: {
    base: '/api/explorer-folders/:id',
    cwdOf(db, id, userId) {
      const row = db.select({ path: explorerFolders.path }).from(explorerFolders)
        .where(and(eq(explorerFolders.id, id), eq(explorerFolders.userId, userId))).get()
      if (!row) throw notFound('workspace_not_found', 'Directory not found.')
      return row.path
    },
  },
} satisfies Record<TreeScope, WorkspaceScope>

// Git operations belong to the session or project. The explorer can open an independent folder.
export const workspaceScopes = [workspaceScope.conversation, workspaceScope.project, workspaceScope.personal]
export const fileWorkspaceScopes = Object.values(workspaceScope)
