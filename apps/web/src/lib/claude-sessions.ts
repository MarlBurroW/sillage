import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentKind, ClaudeSessionsDto, ClaudeSyncDto, ConversationDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Claude Code disk sessions for the project directory not yet linked to conversations. CLI and
 * daemon share an account: importing adopts the native ID rather than copying anything.
 */
export function useCliSessions(projectId: string | undefined, enabled: boolean, agent: AgentKind = 'claude', account: string | null = null) {
  return useQuery({
    queryKey: ['cli-sessions', projectId, agent, account],
    queryFn: () => api.get<ClaudeSessionsDto>(`/api/projects/${projectId}/${agent}-sessions${account ? `?account=${encodeURIComponent(account)}` : ''}`),
    enabled: Boolean(projectId) && enabled,
    staleTime: 30_000,
  })
}

export function useImportCliSession(projectId: string, agent: AgentKind = 'claude', account: string | null = null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sessionId: string) =>
      api.post<ConversationDto>(`/api/projects/${projectId}/${agent}-sessions/${sessionId}/import${account ? `?account=${encodeURIComponent(account)}` : ''}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      void queryClient.invalidateQueries({ queryKey: ['cli-sessions', projectId, agent, account] })
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
