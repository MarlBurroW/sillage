import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BoardLinkSettings, BoardLinkStateDto, CardDto } from '@sillage/protocol'
import { api } from './api'

const linkKey = (projectId: string) => ['board-link', projectId]

/**
 * La liaison du board à GitHub. Relue souvent tant qu'une synchronisation tourne, pour
 * que l'état affiché suive ; sinon toutes les minutes, au rythme des passages.
 */
export function useBoardLink(projectId: string | undefined) {
  return useQuery({
    queryKey: linkKey(projectId ?? ''),
    queryFn: () => api.get<BoardLinkStateDto>(`/api/projects/${projectId}/board-link`),
    enabled: Boolean(projectId),
    staleTime: 15_000,
    refetchInterval: (query) => (query.state.data?.link?.syncing ? 2_000 : query.state.data?.link ? 60_000 : false),
  })
}

/** Ce qu'une synchronisation a pu changer : les cartes, leurs fils, les comptes. */
function invalidateBoard(queryClient: ReturnType<typeof useQueryClient>, projectId: string) {
  void queryClient.invalidateQueries({ queryKey: ['cards', projectId] })
  void queryClient.invalidateQueries({ queryKey: ['card-notes'] })
  void queryClient.invalidateQueries({ queryKey: ['projects'] })
}

export function useSaveBoardLink(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (settings: BoardLinkSettings) => api.put<BoardLinkStateDto>(`/api/projects/${projectId}/board-link`, settings),
    onSuccess: (state) => {
      queryClient.setQueryData(linkKey(projectId), state)
      invalidateBoard(queryClient, projectId)
    },
  })
}

export function useUnlinkBoard(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (keep: boolean) => api.delete<BoardLinkStateDto>(`/api/projects/${projectId}/board-link${keep ? '?keep=1' : ''}`),
    onSuccess: (state) => {
      queryClient.setQueryData(linkKey(projectId), state)
      invalidateBoard(queryClient, projectId)
    },
  })
}

export function useSyncBoard(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<BoardLinkStateDto>(`/api/projects/${projectId}/board-link/sync`),
    onSuccess: (state) => queryClient.setQueryData(linkKey(projectId), state),
    // Même en échec : ce qui a eu le temps de passer est déjà dans la base.
    onSettled: () => {
      invalidateBoard(queryClient, projectId)
      void queryClient.invalidateQueries({ queryKey: linkKey(projectId) })
    },
  })
}

export function useResetHiddenIssues(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<BoardLinkStateDto>(`/api/projects/${projectId}/board-link/hidden/reset`),
    onSuccess: (state) => {
      queryClient.setQueryData(linkKey(projectId), state)
      invalidateBoard(queryClient, projectId)
    },
  })
}

/** Publier une carte locale comme issue, ou rattacher une carte détachée à la sienne. */
export function usePublishCard(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (cardId: string) => api.post<CardDto>(`/api/cards/${cardId}/publish`),
    onSuccess: () => invalidateBoard(queryClient, projectId),
  })
}

export function useDetachCard(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (cardId: string) => api.post<CardDto>(`/api/cards/${cardId}/unlink`),
    onSuccess: () => invalidateBoard(queryClient, projectId),
  })
}
