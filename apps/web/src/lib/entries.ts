import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from './api'

/**
 * Manipulations de fichiers et de dossiers depuis l'explorateur.
 *
 * Chaque opération invalide l'arborescence entière plutôt que le seul niveau touché :
 * un déplacement change deux niveaux, une suppression peut vider l'état git d'un
 * ancêtre, et recalculer ces dépendances côté client reproduirait ce que le serveur
 * sait déjà.
 */
function useEntryMutation<T>(conversationId: string, run: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tree', conversationId] }),
  })
}

export function useCreateEntry(conversationId: string) {
  return useEntryMutation<{ parent: string; name: string; kind: 'file' | 'directory' }>(
    conversationId,
    (body) => api.post(`/api/conversations/${conversationId}/entries`, body),
  )
}

/** Renommer et déplacer sont la même opération : seul le chemin de destination change. */
export function useMoveEntry(conversationId: string) {
  return useEntryMutation<{ from: string; to: string }>(conversationId, (body) =>
    api.post(`/api/conversations/${conversationId}/entries/move`, body),
  )
}

export function useDeleteEntry(conversationId: string) {
  return useEntryMutation<{ path: string }>(conversationId, (body) =>
    api.delete(`/api/conversations/${conversationId}/entries`, body),
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
