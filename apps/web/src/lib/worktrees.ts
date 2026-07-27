import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { WorktreeDto } from '@sillage/protocol'
import { api } from './api'

const worktreesKey = (projectId: string) => ['worktrees', projectId]

export function useWorktrees(projectId: string | undefined) {
  return useQuery({
    queryKey: worktreesKey(projectId ?? ''),
    queryFn: () => api.get<WorktreeDto[]>(`/api/projects/${projectId}/worktrees`),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  })
}

export function useCreateWorktree(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; baseRef: string }) =>
      api.post<WorktreeDto>(`/api/projects/${projectId}/worktrees`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: worktreesKey(projectId) }),
  })
}

export function useDeleteWorktree(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    // `force` n'est jamais implicite : il détruit du travail non commité.
    mutationFn: ({ id, force }: { id: string; force: boolean }) =>
      api.delete<void>(`/api/worktrees/${id}${force ? '?force=1' : ''}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: worktreesKey(projectId) })
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
    },
  })
}

export function useBranches(projectId: string | undefined) {
  return useQuery({
    queryKey: ['branches', projectId],
    queryFn: () =>
      api.get<{ branches: string[]; current: string | null }>(
        `/api/projects/${projectId}/branches`,
      ),
    enabled: Boolean(projectId),
    staleTime: 30_000,
  })
}
