import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { GitCredentialListDto, GitRepoListDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Current account's Git forge access. As with secrets, hooks never read tokens because the API
 * never returns them. Here tokens produce something visible, the repository list, which is the
 * screen's only proof they work.
 */

const CREDENTIALS_KEY = ['git-credentials']

export const GITHUB_HOST = 'github.com'

export function useGitCredentials() {
  return useQuery({
    queryKey: CREDENTIALS_KEY,
    queryFn: () => api.get<GitCredentialListDto>('/api/git-credentials'),
  })
}

export function usePutGitCredential() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { host: string; username: string; token: string }) =>
      api.put<void>('/api/git-credentials', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY })
      // The displayed catalog was built using the previous token.
      void queryClient.invalidateQueries({ queryKey: ['git-repos'] })
    },
  })
}

export function useDeleteGitCredential() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (host: string) =>
      api.delete<void>(`/api/git-credentials/${encodeURIComponent(host)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY })
      void queryClient.invalidateQueries({ queryKey: ['git-repos'] })
    },
  })
}

/**
 * Repositories accessible with the GitHub token, filtered by query. Server-side filtering uses a
 * cached list, allowing per-keystroke queries without exhausting GitHub API quota. Cache results
 * per query, with each typed query a separate key.
 */
export function useGitRepos(query: string, enabled: boolean) {
  return useQuery({
    queryKey: ['git-repos', query],
    queryFn: () =>
      api.get<GitRepoListDto>(
        `/api/git-credentials/${GITHUB_HOST}/repos?q=${encodeURIComponent(query)}`,
      ),
    enabled,
    // Server cache lasts five minutes; a longer client cache would only show older data than a new
    // query could return.
    staleTime: 60_000,
    // Keep previous results visible while typing or the list flashes empty between letters.
    placeholderData: (previous) => previous,
  })
}
