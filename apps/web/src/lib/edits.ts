import { useQuery } from '@tanstack/react-query'
import type { EditDiffDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Edits made to a file by a tool call. Reconstructed server-side from native log payload and
 * immutable after the turn, so cache need not expire. Mount only upon row expansion: turns often
 * touch dozens of files and users inspect only one.
 */
export function useEditDiff(conversationId: string, toolCallId: string, path: string) {
  return useQuery({
    queryKey: ['edit', conversationId, toolCallId, path],
    queryFn: () =>
      api.get<EditDiffDto>(
        `/api/conversations/${conversationId}/edits/${toolCallId}?path=${encodeURIComponent(path)}`,
      ),
    staleTime: Infinity,
  })
}
