import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TerminalDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Cycle de vie des terminaux d'une conversation.
 *
 * Les terminaux vivent en mémoire du daemon, pas en base : un redémarrage les emporte,
 * ce qui est le comportement d'un shell. La liste est donc relue à l'ouverture du
 * panneau plutôt que gardée longtemps en cache.
 */

const key = (conversationId: string) => ['terminals', conversationId]

export function useTerminals(conversationId: string, enabled: boolean) {
  return useQuery({
    queryKey: key(conversationId),
    queryFn: () => api.get<TerminalDto[]>(`/api/conversations/${conversationId}/terminals`),
    enabled,
    staleTime: 5_000,
  })
}

export function useOpenTerminal(conversationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<TerminalDto>(`/api/conversations/${conversationId}/terminals`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(conversationId) }),
  })
}

export function useCloseTerminal(conversationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (terminalId: string) =>
      api.delete(`/api/conversations/${conversationId}/terminals/${terminalId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(conversationId) }),
  })
}

export function useRenameTerminal(conversationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.patch<TerminalDto>(`/api/conversations/${conversationId}/terminals/${id}`, { title }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(conversationId) }),
  })
}
