import type { TreeScope } from '@sillage/protocol'

/** Bare conversation IDs preserve existing editor tabs and cache keys. */
export type WorkspaceScope = string

export const projectScope = (id: string): WorkspaceScope => encodeScope('project', id)
export const personalWorkspaceScope = (id: string): WorkspaceScope => encodeScope('personal', id)

export function encodeScope(kind: TreeScope, id: string): WorkspaceScope {
  return kind === 'conversation' ? id : `${kind}:${id}`
}

export function decodeScope(scope: WorkspaceScope): { kind: TreeScope; id: string } {
  for (const kind of ['project', 'personal', 'folder', 'project-folder'] as const) {
    if (scope.startsWith(`${kind}:`)) return { kind, id: scope.slice(kind.length + 1) }
  }
  return { kind: 'conversation', id: scope }
}

/** Panel route prefix for this scope. */
export function workspaceApiBase(scope: WorkspaceScope): string {
  const { kind, id } = decodeScope(scope)
  switch (kind) {
    case 'conversation': return `/api/conversations/${id}`
    case 'project': return `/api/projects/${id}`
    case 'personal': return `/api/personal-workspaces/${id}`
    case 'project-folder': return `/api/project-folders/${id}`
    case 'folder': return `/api/explorer-folders/${id}`
  }
}
