import { useQuery } from '@tanstack/react-query'
import { api } from './api'

export interface FileMatchDto {
  /** Working-directory-relative path as written after `@`. */
  path: string
  name: string
}

/**
 * Files suggested for mentions. Key the query by project rather than conversation: composers
 * already complete mentions before a conversation exists.
 */
export function useFileSuggestions(
  projectId: string | undefined,
  worktreeId: string | null,
  query: string | null,
) {
  return useQuery({
    queryKey: ['files', projectId, worktreeId, query],
    queryFn: async () => {
      const params = new URLSearchParams({ q: query ?? '' })
      if (worktreeId) params.set('worktreeId', worktreeId)
      const result = await api.get<{ files: FileMatchDto[] }>(
        `/api/projects/${projectId}/files?${params}`,
      )
      return result.files
    },
    enabled: Boolean(projectId) && query !== null,
    // File lists do not change every second: avoid rereading on every keystroke for a previously queried prefix.
    staleTime: 15_000,
  })
}
