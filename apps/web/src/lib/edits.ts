import { useQuery } from '@tanstack/react-query'
import type { EditDiffDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Ce qu'un appel d'outil a fait d'un fichier.
 *
 * Reconstitué par le serveur depuis le payload natif du journal, donc immuable une
 * fois le tour passé : le cache n'a aucune raison d'expirer. Le composant n'est monté
 * qu'une fois la ligne dépliée, un tour touchant couramment plusieurs dizaines de
 * fichiers dont on n'en regarde qu'un.
 */
export function useEditDiff(conversationId: string, toolCallId: string, path: string) {
  return useQuery({
    queryKey: ['edit', conversationId, toolCallId, path],
    queryFn: () =>
      api.get<EditDiffDto>(
        `/api/conversations/${conversationId}/edits/${toolCallId}?path=${encodeURIComponent(path)}`,
      ),
    staleTime: Infinity,
  })
}
