import type { TreeSearchDto } from '@sillage/protocol'
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
  projectId: string | null | undefined,
  worktreeId: string | null,
  query: string | null,
  conversationId?: string,
) {
  return useQuery({
    queryKey: ['files', projectId, conversationId, worktreeId, query],
    queryFn: async () => {
      if (!projectId && conversationId) {
        if ((query?.length ?? 0) < 2) return []
        const result = await api.get<TreeSearchDto>(`/api/conversations/${conversationId}/tree/search?q=${encodeURIComponent(query ?? '')}`)
        return result.entries.filter(entry => !entry.isDirectory).map(entry => ({ path: entry.path, name: entry.name }))
      }
      const params = new URLSearchParams({ q: query ?? '' })
      if (worktreeId) params.set('worktreeId', worktreeId)
      const result = await api.get<{ files: FileMatchDto[] }>(
        `/api/projects/${projectId}/files?${params}`,
      )
      return result.files
    },
    enabled: Boolean(projectId || conversationId) && query !== null,
    // File lists do not change every second: avoid rereading on every keystroke for a previously queried prefix.
    staleTime: 15_000,
  })
}
