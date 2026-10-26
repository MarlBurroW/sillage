/**
 * Side-panel scope: either a conversation's cwd including worktree, or a project's workspace.
 * Encode as a string rather than an object: bare conversation IDs preserve thread calls (openTab,
 * cache keys), while projects use a prefix. Forms cannot collide and decoding lives only here.
 */
export type WorkspaceScope = string

const PROJECT_PREFIX = 'project:'
const PERSONAL_PREFIX = 'personal:'
export const personalWorkspaceScope = (id: string): WorkspaceScope => `${PERSONAL_PREFIX}${id}`

export const projectScope = (projectId: string): WorkspaceScope =>
  `${PROJECT_PREFIX}${projectId}`

export function decodeScope(scope: WorkspaceScope): {
  kind: 'conversation' | 'project' | 'personal'
  id: string
} {
  if (scope.startsWith(PERSONAL_PREFIX)) return { kind: 'personal', id: scope.slice(PERSONAL_PREFIX.length) }
  return scope.startsWith(PROJECT_PREFIX)
    ? { kind: 'project', id: scope.slice(PROJECT_PREFIX.length) }
    : { kind: 'conversation', id: scope }
}

/** Panel route prefix for this scope. */
export function workspaceApiBase(scope: WorkspaceScope): string {
  const { kind, id } = decodeScope(scope)
  if (kind === 'personal') return `/api/personal-workspaces/${id}`
  return kind === 'project' ? `/api/projects/${id}` : `/api/conversations/${id}`
}
