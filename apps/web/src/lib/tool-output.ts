import { useQuery } from '@tanstack/react-query'
import type { ToolOutputDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Full tool output omitted by history replay. The log is immutable after the turn, so cache never
 * expires. Enable queries only when cards open: long conversations contain hundreds of large
 * outputs, few ever viewed, precisely why they no longer travel with the thread.
 */
export function useToolOutput(conversationId: string, toolCallId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['tool-output', conversationId, toolCallId],
    queryFn: () =>
      api.get<ToolOutputDto>(`/api/conversations/${conversationId}/tools/${toolCallId}/output`),
    staleTime: Infinity,
    enabled,
  })
}
