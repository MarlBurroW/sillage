/**
 * Portée du panneau latéral : le répertoire consulté appartient soit à une
 * conversation (son cwd, worktree compris), soit à un projet (son workspace).
 *
 * Encodée en chaîne plutôt qu'en objet : une conversation garde son identifiant nu, ce
 * qui laisse inchangés les appels du fil (openTab, clés de cache) qui ne connaissent
 * qu'elle ; un projet se préfixe. Les deux formes ne peuvent pas se confondre, et le
 * décodage vit ici, nulle part ailleurs.
 */
export type WorkspaceScope = string

const PROJECT_PREFIX = 'project:'

export const projectScope = (projectId: string): WorkspaceScope =>
  `${PROJECT_PREFIX}${projectId}`

export function decodeScope(scope: WorkspaceScope): {
  kind: 'conversation' | 'project'
  id: string
} {
  return scope.startsWith(PROJECT_PREFIX)
    ? { kind: 'project', id: scope.slice(PROJECT_PREFIX.length) }
    : { kind: 'conversation', id: scope }
}

/** Préfixe des routes du panneau pour cette portée. */
export function workspaceApiBase(scope: WorkspaceScope): string {
  const { kind, id } = decodeScope(scope)
  return kind === 'project' ? `/api/projects/${id}` : `/api/conversations/${id}`
}
