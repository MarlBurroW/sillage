import { useQuery } from '@tanstack/react-query'
import type { AgentKind, ProjectCommandsDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Commandes en `/` que le CLI reconnaît dans le dossier du projet, avant qu'une
 * conversation existe. Une fois le fil créé, c'est `commands.updated` qui fait foi.
 *
 * La sonde démarre un process CLI et le serveur ne met en cache que ses réussites :
 * pas de nouvel essai ni de relecture au retour sur l'onglet, un échec ne changerait
 * pas tout seul. `enabled` est à la charge de l'appelant, qui sait si le CLI est
 * installé et si le dossier visé est déjà connu.
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
