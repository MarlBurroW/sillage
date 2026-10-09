import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import type {
  GitArea,
  GitBranchesDto,
  GitFileDiffDto,
  GitStashListDto,
  GitStatusDto,
} from '@sillage/protocol'
import { api } from './api'
import { workspaceApiBase, type WorkspaceScope } from './workspace-scope'

/**
 * Lectures et actions git de l'onglet Git.
 *
 * Toutes les clés commencent par `['git', scope]` : une action, quelle qu'elle soit,
 * invalide tout ce que l'onglet sait du dépôt d'un coup. Chercher ce qu'un `pull` a pu
 * changer (la branche, l'index, les commits, les stashs) serait toujours incomplet.
 */

const gitKey = (scope: WorkspaceScope, ...rest: string[]) => ['git', scope, ...rest]

export function useGitStatus(scope: WorkspaceScope) {
  return useQuery({
    queryKey: gitKey(scope, 'status'),
    queryFn: () => api.get<GitStatusDto>(`${workspaceApiBase(scope)}/git/status`),
    // Relu à chaque ouverture de l'onglet, à la fin d'un tour, et après chaque action.
    // Jamais en boucle : un statut lance six processus git.
    staleTime: Infinity,
    refetchOnMount: 'always',
  })
}

export function useGitBranches(scope: WorkspaceScope, enabled: boolean) {
  return useQuery({
    queryKey: gitKey(scope, 'branches'),
    queryFn: () => api.get<GitBranchesDto>(`${workspaceApiBase(scope)}/git/branches`),
    staleTime: Infinity,
    refetchOnMount: 'always',
    enabled,
  })
}

export function useGitStashes(scope: WorkspaceScope, enabled: boolean) {
  return useQuery({
    queryKey: gitKey(scope, 'stashes'),
    queryFn: () => api.get<GitStashListDto>(`${workspaceApiBase(scope)}/git/stashes`),
    staleTime: Infinity,
    refetchOnMount: 'always',
    enabled,
  })
}

/** Le diff d'un fichier, demandé seulement quand on le déplie. */
export function useGitFileDiff(scope: WorkspaceScope, path: string, area: GitArea, enabled: boolean) {
  return useQuery({
    queryKey: gitKey(scope, 'file-diff', area, path),
    queryFn: () =>
      api.get<GitFileDiffDto>(
        `${workspaceApiBase(scope)}/git/file-diff?path=${encodeURIComponent(path)}&area=${area}`,
      ),
    staleTime: Infinity,
    enabled,
  })
}

/**
 * Relit tout ce qui dépend du dépôt.
 *
 * Au-delà de l'onglet lui-même : l'arborescence porte les couleurs d'état git, la liste
 * des projets et des worktrees leur branche et leur propreté, le sélecteur de worktree
 * ses branches. Un commit ou un checkout les change tous.
 */
export function useRefreshGit(scope: WorkspaceScope): () => void {
  const queryClient = useQueryClient()
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['git', scope] })
    void queryClient.invalidateQueries({ queryKey: ['commits', scope] })
    void queryClient.invalidateQueries({ queryKey: ['tree', scope] })
    void queryClient.invalidateQueries({ queryKey: ['tree-search', scope] })
    void queryClient.invalidateQueries({ queryKey: ['projects'] })
    void queryClient.invalidateQueries({ queryKey: ['worktrees'] })
    void queryClient.invalidateQueries({ queryKey: ['branches'] })
  }, [queryClient, scope])
}

/**
 * Une action git de la portée.
 *
 * Le dépôt est relu que l'action ait réussi ou non : un `merge` refusé peut quand même
 * avoir touché l'index, et l'onglet doit montrer le dépôt tel qu'il est, pas tel qu'on
 * l'espérait.
 */
export function useGitAction<Body = void, Result = void>(
  scope: WorkspaceScope,
  path: string,
  options: { method?: 'post' | 'delete' } = {},
) {
  const refresh = useRefreshGit(scope)
  const method = options.method ?? 'post'
  return useMutation({
    mutationFn: (body: Body) =>
      api[method]<Result>(`${workspaceApiBase(scope)}/git/${path}`, body ?? undefined),
    onSettled: refresh,
  })
}
