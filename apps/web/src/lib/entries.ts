import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import { workspaceApiBase, type WorkspaceScope } from './workspace-scope'

/**
 * Manipulations de fichiers et de dossiers depuis l'explorateur.
 *
 * Chaque opération invalide l'arborescence entière plutôt que le seul niveau touché :
 * un déplacement change deux niveaux, une suppression peut vider l'état git d'un
 * ancêtre, et recalculer ces dépendances côté client reproduirait ce que le serveur
 * sait déjà.
 */
function useEntryMutation<T>(scope: WorkspaceScope, run: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tree', scope] }),
  })
}

export function useCreateEntry(scope: WorkspaceScope) {
  return useEntryMutation<{ parent: string; name: string; kind: 'file' | 'directory' }>(
    scope,
    (body) => api.post(`${workspaceApiBase(scope)}/entries`, body),
  )
}

/** Renommer et déplacer sont la même opération : seul le chemin de destination change. */
export function useMoveEntry(scope: WorkspaceScope) {
  return useEntryMutation<{ from: string; to: string }>(scope, (body) =>
    api.post(`${workspaceApiBase(scope)}/entries/move`, body),
  )
}

export function useDeleteEntry(scope: WorkspaceScope) {
  return useEntryMutation<{ path: string }>(scope, (body) =>
    api.delete(`${workspaceApiBase(scope)}/entries`, body),
  )
}

/** Dossier parent d'un chemin relatif, chaîne vide à la racine. */
export function parentOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
}

/** Même dossier, autre nom. */
export function siblingPath(path: string, name: string): string {
  const parent = parentOf(path)
  return parent ? `${parent}/${name}` : name
}
