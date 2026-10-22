import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TerminalDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Project terminal lifecycle. Scope by project rather than conversation: lists are shared
 * project-wide and servers launched in shells cannot become hidden behind archived sessions.
 * Processes live in daemon memory; restart interrupts them but restores their entries marked
 * interrupted with the last screen.
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
