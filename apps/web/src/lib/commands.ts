import { useQuery } from '@tanstack/react-query'
import type { AgentKind, ProjectCommandsDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Slash commands recognized in the project directory before a conversation exists. After creation,
 * `commands.updated` is authoritative. Probing starts a CLI process and the server caches only
 * successes: disable retries and tab-return refetch because failure will not fix itself. The caller
 * controls `enabled`, knowing CLI presence and directory availability.
 */
export function useProjectCommands(
  projectId: string | undefined,
  agent: AgentKind,
  worktreeId: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['project-commands', projectId, agent, worktreeId],
    queryFn: () => {
      const params = new URLSearchParams({ agent })
      if (worktreeId) params.set('worktreeId', worktreeId)
      return api.get<ProjectCommandsDto>(`/api/projects/${projectId}/commands?${params}`)
    },
    enabled: Boolean(projectId) && enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  })
}
