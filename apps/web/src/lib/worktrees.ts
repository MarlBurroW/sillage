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
 * L'avancement des chantiers d'un projet : chaque arbre jugé contre la branche par
 * défaut, avec les sessions qui y tiennent.
 *
 * Une seule requête par projet, partagée entre toutes les lignes de la barre latérale
 * qui la lisent : aucune commande git ne part d'un rendu. Le serveur peut répondre
 * d'une liste périmée pendant qu'il recalcule (`fresh: false`) : on repasse alors
 * peu après, une fois, pour avoir la suivante.
 */
export function useWorktreeStatuses(projectId: string | undefined) {
  return useQuery({
    queryKey: statusKey(projectId ?? ''),
    queryFn: () => api.get<WorktreeStatusListDto>(`/api/projects/${projectId}/worktrees/status`),
    enabled: Boolean(projectId),
    staleTime: 15_000,
    refetchInterval: (query) => (query.state.data && !query.state.data.fresh ? 2_000 : false),
  })
}

/**
 * L'arbre auquel une conversation tient, pour sa ligne dans la barre latérale.
 *
 * Son cwd d'abord (lien `worktree`), sinon l'arbre où elle a écrit, le plus récemment
 * actif en premier : la liste est déjà triée ainsi par le serveur. Null pour une session
 * de l'arbre principal, qui n'affiche rien de plus : c'est le contraste qui fait
 * repérer les autres.
 */
export function useConversationWorktree(conversation: Pick<ConversationDto, 'id' | 'projectId'>): WorktreeStatusDto | null {
  const { data } = useWorktreeStatuses(conversation.projectId)
  return useMemo(() => {
    if (!data) return null
    let edited: WorktreeStatusDto | null = null
    for (const tree of data.worktrees) {
      const link = tree.conversations.find((entry) => entry.id === conversation.id)
      if (!link) continue
      if (link.link === 'worktree') return tree
      edited ??= tree
    }
    return edited
  }, [data, conversation.id])
}

/** Ce qui reste à faire ou à nettoyer, pour le compteur près du projet. */
export function worktreeCounts(list: WorktreeStatusListDto | undefined): { pending: number; cleanable: number } {
  let pending = 0
  let cleanable = 0
  for (const tree of list?.worktrees ?? []) {
    if (tree.state === 'merged') cleanable += 1
    else pending += 1
  }
  return { pending, cleanable }
}

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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: worktreesKey(projectId) })
      void queryClient.invalidateQueries({ queryKey: statusKey(projectId) })
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

/** Ce que le nettoyage ferait d'un arbre, lu à l'ouverture de la confirmation. */
export function useWorktreeCleanupPlan(projectId: string, path: string | null) {
  return useQuery({
    queryKey: ['worktree-cleanup', projectId, path],
    queryFn: () =>
      api.get<WorktreeCleanupPlanDto>(`/api/projects/${projectId}/worktrees/cleanup?path=${encodeURIComponent(path ?? '')}`),
    enabled: path !== null,
    // Relu à chaque ouverture : ce qui tourne dans l'arbre change d'une minute à l'autre.
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
