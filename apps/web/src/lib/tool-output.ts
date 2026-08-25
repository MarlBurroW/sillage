import { useQuery } from '@tanstack/react-query'
import type { ToolOutputDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Sortie complète d'un appel d'outil, quand la relecture n'en a rendu qu'un aperçu.
 *
 * Le journal ne bouge plus une fois le tour passé, donc le cache n'a aucune raison
 * d'expirer. La requête n'est armée qu'à l'ouverture de la carte : une conversation
 * longue porte des centaines de sorties volumineuses dont on n'en ouvre presque aucune,
 * et c'est précisément pour ça qu'elles ne sont plus transférées avec le fil.
 */
export function useToolOutput(conversationId: string, toolCallId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['tool-output', conversationId, toolCallId],
    queryFn: () =>
      api.get<ToolOutputDto>(`/api/conversations/${conversationId}/tools/${toolCallId}/output`),
    staleTime: Infinity,
    enabled,
  })
}
