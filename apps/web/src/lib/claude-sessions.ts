import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ClaudeSessionsDto, ClaudeSyncDto, ConversationDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Sessions Claude Code trouvées sur le disque pour le dossier du projet, pas encore
 * rattachées à une conversation. Le CLI et le daemon partagent le même compte :
 * importer revient à adopter l'identifiant natif, pas à copier quoi que ce soit.
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
 * Rattrape dans le journal les tours faits au CLI depuis la dernière ouverture.
 * Les événements repris arrivent par l'abonnement WebSocket, comme le direct.
 */
export function syncClaudeConversation(conversationId: string): Promise<ClaudeSyncDto> {
  return api.post<ClaudeSyncDto>(`/api/conversations/${conversationId}/claude-sync`)
}
