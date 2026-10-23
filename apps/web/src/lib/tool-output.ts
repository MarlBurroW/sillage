import { useQuery } from '@tanstack/react-query'
import type { EventBodyRef, ToolOutputDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Full tool output omitted by history replay. The log is immutable after the turn, so an open card never needs to refresh. Enable queries only when cards open: long conversations contain hundreds of large
 * outputs, few ever viewed, precisely why they no longer travel with the thread.
 */
export function useToolOutput(conversationId: string, toolCallId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['tool-output', conversationId, toolCallId],
    queryFn: ({ signal }) =>
      api.get<ToolOutputDto>(`/api/conversations/${conversationId}/tools/${encodeURIComponent(toolCallId)}/output`, signal),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    enabled,
  })
}

/** No inactive body cache: closing/unmounting releases data and cancels an unfinished fetch.
 * Active cards own their bodies; the thread snapshots retain only the reference. */
export function useEventBody(conversationId: string, ref: EventBodyRef | undefined) {
  return useQuery({
    queryKey: ['event-body', conversationId, ref?.seq, ref?.field, ref?.block],
    queryFn: ({ signal }) => api.get<{ value: unknown }>(
      `/api/conversations/${conversationId}/events/${ref!.seq}/body/${ref!.field}${ref!.block === undefined ? '' : `?block=${ref!.block}`}`,
      signal,
    ),
    enabled: ref !== undefined,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  })
}
