import { useQuery } from '@tanstack/react-query'
import type { CommitDiffDto, CommitListDto } from '@sillage/protocol'
import { api } from './api'
import { workspaceApiBase, type WorkspaceScope } from './workspace-scope'

/** Initial commit batch size and subsequent load step. */
export const COMMIT_PAGE = 30

/**
 * Latest commits on the viewed directory's branch. Grow `limit` rather than offset pagination:
 * rereading avoids stitching pages that may shift between reads. Agent commits prepend entries and
 * rebases rewrite existing ones. Rereading a hundred `git log` lines is cheap.
 */
export function useCommits(scope: WorkspaceScope, limit: number, all = false) {
  return useQuery({
    queryKey: ['commits', scope, limit, all],
    // Loading more must neither empty the graph nor lose reading position.
    placeholderData: (previous, query) =>
      query?.queryKey[1] === scope && query.queryKey[3] === all ? previous : undefined,
    queryFn: () => api.get<CommitListDto>(`${workspaceApiBase(scope)}/commits?limit=${limit}&all=${all}`),
    // Like diffs: reread on tab opening and turn completion, never poll. Every read starts a Git process.
    staleTime: Infinity,
    refetchOnMount: 'always',
  })
}

/** Commit diff requested only on expansion. */
export function useCommitDiff(scope: WorkspaceScope, hash: string, enabled: boolean) {
  return useQuery({
    queryKey: ['commit-diff', scope, hash],
    queryFn: () => api.get<CommitDiffDto>(`${workspaceApiBase(scope)}/commits/${hash}/diff`),
    // Commits are immutable: once read, there is no reason to refetch.
    staleTime: Infinity,
    enabled,
  })
}
