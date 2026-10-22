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
 * Git reads and actions for the Git tab. Every key starts with `['git', scope]`: any action
 * invalidates all repository knowledge at once. Enumerating everything changed by `pull` (branch,
 * index, commits, stashes) would always be incomplete.
 */

const gitKey = (scope: WorkspaceScope, ...rest: string[]) => ['git', scope, ...rest]

export function useGitStatus(scope: WorkspaceScope) {
  return useQuery({
    queryKey: gitKey(scope, 'status'),
    queryFn: () => api.get<GitStatusDto>(`${workspaceApiBase(scope)}/git/status`),
    // Reread on tab opening, turn completion, and after actions. Never poll: status launches
    // several Git processes.
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

/** File diff requested only on expansion. */
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
 * Reread everything depending on the repository, beyond this tab: tree Git colors, project/worktree
 * branches and cleanliness, and worktree-switcher branches. Commits and checkouts affect them all.
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
    void queryClient.invalidateQueries({ queryKey: ['worktree-status'] })
    void queryClient.invalidateQueries({ queryKey: ['branches'] })
  }, [queryClient, scope])
}

/**
 * Git action within the scope. Reread on success or failure: rejected merges may still alter the
 * index, and the tab must show the actual repository rather than the expected result.
 */
export function useGitAction<Body = void, Result = void>(
  scope: WorkspaceScope,
  path: string,
  options: { method?: 'post' | 'delete' } = {},
) {
  const refresh = useRefreshGit(scope)
  const method = options.method ?? 'post'
  return useMutation({
    mutationFn: async (body: Body) => {
      const url = `${workspaceApiBase(scope)}/git/${path}`
      const paths = (body as { paths?: string[] } | undefined)?.paths
      // Global actions retain every file without exceeding API or Git argument limits, particularly on Windows.
      if (['stage', 'unstage', 'discard'].includes(path) && paths && (paths.length > 100 || paths.join('').length > 8000)) {
        let result: Result | undefined
        let offset = 0
        while (offset < paths.length) {
          const batch: string[] = []
          let length = 0
          while (offset < paths.length && batch.length < 100) {
            const file = paths[offset]!
            if (batch.length > 0 && length + file.length > 8000) break
            batch.push(file)
            length += file.length
            offset += 1
          }
          result = await api[method]<Result>(url, { ...body, paths: batch })
        }
        return result as Result
      }
      return api[method]<Result>(url, body ?? undefined)
    },
    onSettled: refresh,
  })
}
