import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ClaudeSessionsDto, ClaudeSyncDto, ConversationDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Claude Code disk sessions for the project directory not yet linked to conversations. CLI and
 * daemon share an account: importing adopts the native ID rather than copying anything.
 */
export function useClaudeSessions(projectId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['claude-sessions', projectId],
    queryFn: () => api.get<ClaudeSessionsDto>(`/api/projects/${projectId}/claude-sessions`),
    enabled: Boolean(projectId) && enabled,
    staleTime: 30_000,
  })
}

export function useImportClaudeSession(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sessionId: string) =>
      api.post<ConversationDto>(`/api/projects/${projectId}/claude-sessions/${sessionId}/import`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      void queryClient.invalidateQueries({ queryKey: ['claude-sessions', projectId] })
    },
  })
}

/**
 * Catch up the log with CLI turns since the last opening. Recovered events arrive over WebSocket
 * like live output.
 */
export function syncClaudeConversation(conversationId: string): Promise<ClaudeSyncDto> {
  return api.post<ClaudeSyncDto>(`/api/conversations/${conversationId}/claude-sync`)
}
