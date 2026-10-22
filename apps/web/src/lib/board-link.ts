import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BoardLinkSettings, BoardLinkStateDto, CardDto } from '@sillage/protocol'
import { api } from './api'

const linkKey = (projectId: string) => ['board-link', projectId]

/**
 * Board GitHub connection. Poll closely during synchronization to track state, otherwise every
 * minute matching synchronization cadence.
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

/** Data synchronization may change: cards, threads, and counts. */
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
    // Even on failure: successfully processed data is already in the database.
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

/** Publish a local card as an issue or reconnect a detached card to its existing issue. */
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
