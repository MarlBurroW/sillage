import type { ConversationStatsDto } from '@sillage/protocol'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'

/**
 * Cost and tool activity of a conversation, fetched when its details open rather than with the
 * list: the server prices turns and counts journal entries for it. A short stale time keeps a
 * working session's figures moving without refetching on every hover.
 */
export function useConversationStats(conversationId: string, enabled = true) {
  return useQuery({
    queryKey: ['conversation-stats', conversationId],
    queryFn: () => api.get<ConversationStatsDto>(`/api/conversations/${encodeURIComponent(conversationId)}/stats`),
    staleTime: 15_000,
    enabled,
  })
}
