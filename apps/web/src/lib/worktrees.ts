import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import type {
  ConversationDto,
  WorktreeCleanupPlanDto,
  WorktreeCleanupResultDto,
  WorktreeDto,
  WorktreeStatusDto,
  WorktreeStatusListDto,
} from '@sillage/protocol'
import { api } from './api'

const worktreesKey = (projectId: string) => ['worktrees', projectId]
const statusKey = (projectId: string) => ['worktree-status', projectId]

/**
 * Project worktree progress: each tree compared with the default branch plus its associated
 * sessions. One project query shared by all sidebar rows; rendering never runs Git. The server may
 * return stale data while recalculating (`fresh: false`); retry once shortly afterward for the next
 * snapshot.
 */
export function useWorktreeStatuses(projectId: string | null | undefined) {
  return useQuery({
    queryKey: statusKey(projectId ?? ''),
    queryFn: () => api.get<WorktreeStatusListDto>(`/api/projects/${projectId}/worktrees/status`),
    enabled: Boolean(projectId),
    staleTime: 15_000,
    refetchInterval: (query) => (query.state.data && !query.state.data.fresh ? 2_000 : false),
  })
}

/**
 * Conversation-associated tree for the sidebar row. Prefer its cwd (`worktree` link), otherwise the
 * tree the conversation wrote in most recently. The server list is sorted by urgency, which would
 * pin a long-lived session that prepared many trees to the worst one it once created rather than
 * to its latest work. Null for main-tree sessions, which need no extra label: contrast identifies
 * others.
 */
export function useConversationWorktree(conversation: Pick<ConversationDto, 'id' | 'projectId'>): WorktreeStatusDto | null {
  const { data } = useWorktreeStatuses(conversation.projectId)
  return useMemo(() => {
    if (!data) return null
    let edited: WorktreeStatusDto | null = null
    let editedAt = -1
    for (const tree of data.worktrees) {
      const link = tree.conversations.find((entry) => entry.id === conversation.id)
      if (!link) continue
      if (link.link === 'worktree') return tree
      if (link.lastActiveAt > editedAt) {
        edited = tree
        editedAt = link.lastActiveAt
      }
    }
    return edited
  }, [data, conversation.id])
}

/** Remaining work, merged trees with files to sort, and cleanup for the project counter. */
export function worktreeCounts(list: WorktreeStatusListDto | undefined): { pending: number; leftovers: number; cleanable: number } {
  let pending = 0
  let leftovers = 0
  let cleanable = 0
  for (const tree of list?.worktrees ?? []) {
    if (tree.state === 'merged') cleanable += 1
    else if (tree.state === 'leftovers') leftovers += 1
    else pending += 1
  }
  return { pending, leftovers, cleanable }
}

export function useWorktrees(projectId: string | null | undefined) {
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: worktreesKey(projectId) })
      void queryClient.invalidateQueries({ queryKey: statusKey(projectId) })
    },
  })
}

export function useBranches(projectId: string | null | undefined) {
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

/** Keeps the files shown for a merged tree; the server refuses with 409 if they changed since. */
export function useKeepWorktreeFiles(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { path: string; fingerprint: string }) =>
      api.post<void>(`/api/projects/${projectId}/worktrees/keep`, input),
    // Refused or not, the list shown is outdated or settled: reread it either way.
    onSettled: () => queryClient.invalidateQueries({ queryKey: statusKey(projectId) }),
  })
}

export function useForgetKeptFiles(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (path: string) =>
      api.delete<void>(`/api/projects/${projectId}/worktrees/keep?path=${encodeURIComponent(path)}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: statusKey(projectId) }),
  })
}

/** Cleanup preview for a tree, read when opening confirmation. */
export function useWorktreeCleanupPlan(projectId: string, path: string | null) {
  return useQuery({
    queryKey: ['worktree-cleanup', projectId, path],
    queryFn: () =>
      api.get<WorktreeCleanupPlanDto>(`/api/projects/${projectId}/worktrees/cleanup?path=${encodeURIComponent(path ?? '')}`),
    enabled: path !== null,
    // Reread on each opening: active processes within a tree can change minute to minute.
    staleTime: 0,
    gcTime: 0,
  })
}

export function useCleanWorktree(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { path: string; deleteBranch: boolean; archiveSessions: boolean; stopServices: boolean }) =>
      api.post<WorktreeCleanupResultDto>(`/api/projects/${projectId}/worktrees/cleanup`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: worktreesKey(projectId) })
      void queryClient.invalidateQueries({ queryKey: statusKey(projectId) })
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      void queryClient.invalidateQueries({ queryKey: ['branches'] })
      void queryClient.invalidateQueries({ queryKey: ['services'] })
    },
  })
}
