import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TerminalDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Cycle de vie des terminaux d'un projet.
 *
 * Scopés au projet et non à la conversation : la liste est la même partout dans le
 * projet, et un serveur lancé dans un shell ne peut pas se retrouver caché derrière
 * une session archivée. Les process vivent en mémoire du daemon ; un redémarrage les
 * interrompt mais leurs entrées reviennent, marquées telles, avec leur dernier écran.
 */

const key = (projectId: string) => ['terminals', projectId]

export function useTerminals(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: key(projectId),
    queryFn: () => api.get<TerminalDto[]>(`/api/projects/${projectId}/terminals`),
    enabled,
    staleTime: 5_000,
  })
}

export function useOpenTerminal(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input?: { conversationId?: string; cwd?: string }) =>
      api.post<TerminalDto>(`/api/projects/${projectId}/terminals`, input ?? {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(projectId) }),
  })
}

export function useCloseTerminal(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (terminalId: string) =>
      api.delete(`/api/projects/${projectId}/terminals/${terminalId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(projectId) }),
  })
}

export function useRenameTerminal(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.patch<TerminalDto>(`/api/projects/${projectId}/terminals/${id}`, { title }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(projectId) }),
  })
}
