import type { ProjectRow, UserRow } from '@sillage/db'
import type { AppContext } from './context.js'
import { forbidden, notFound } from './errors.js'
import { visibleProject } from './routes/projects.js'

/**
 * Who may change the configuration sessions inherit: instructions, memory, skills, MCP servers.
 *
 * One rule, so every scoped entity answers alike. What is instance-wide belongs to
 * administrators, because it reaches every session of every account. What lives in a project
 * belongs to that project's owner, administrator or not. Members of a shared project read its
 * configuration and work in it (sessions, cards, actions, worktrees) without changing it, and an
 * administrator has no special right in a project they do not own.
 *
 * It prevents accidents and says who decides. It is not a security boundary: every agent runs as
 * the same system user and reaches the database from its shell. The agent-side twin lives in
 * `mcp/sillage-mcp.mjs` (`actingAccountOwnsProject`, `conversationOwnerIsAdmin`), which is outside
 * the module graph and must keep answering the same way.
 */
export function canWriteScope(
  user: Pick<UserRow, 'id' | 'isAdmin'>,
  project: Pick<ProjectRow, 'ownerId'> | null,
): boolean {
  return project === null ? user.isAdmin : project.ownerId === user.id
}

/**
 * The project for a project scope, null for the instance scope; throws when the caller may not
 * write there. A project the caller cannot see is reported as missing rather than forbidden.
 */
export function assertScopeWriter(ctx: AppContext, user: UserRow, projectId: string | null): ProjectRow | null {
  if (projectId === null) {
    if (!user.isAdmin) throw forbidden('admin_only', 'Administrators only.')
    return null
  }
  const project = visibleProject(ctx, projectId, user.id)
  if (!project) throw notFound('project_not_found', 'Project not found.')
  if (project.ownerId !== user.id) {
    throw forbidden('project_edit_forbidden', 'Only the owner can modify this project.')
  }
  return project
}
