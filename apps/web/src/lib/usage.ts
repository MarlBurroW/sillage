import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentKind, AgentUsage } from '@sillage/protocol'
import { api } from './api'

const usageKey = (agent: AgentKind) => ['usage', agent]

/**
 * Consommation du compte.
 *
 * `staleTime` à zéro : le hook n'est monté que pendant que le panneau est ouvert, donc
 * chaque ouverture redemande la valeur. Le garde-fou est côté serveur, où se trouve le
 * coût réel (une lecture y démarre un process CLI) : deux caches empilés donneraient une
 * fraîcheur impossible à raisonner, et un panneau qui semble ne rien relire.
 *
 * La valeur précédente reste en cache le temps de la relecture, donc rouvrir affiche
 * l'ancienne mesure immédiatement plutôt qu'un écran vide.
 */
export function useAgentUsage(agent: AgentKind) {
  return useQuery({
    queryKey: usageKey(agent),
    queryFn: () => api.get<AgentUsage>(`/api/agents/${agent}/usage`),
    staleTime: 0,
    // La consommation d'un compte n'a pas d'à-coups : réessayer en boucle ne ferait
    // que relancer des CLI pour rien.
    retry: false,
  })
}

/** Relecture explicite, qui court-circuite aussi le cache du serveur. */
export function useRefreshUsage(agent: AgentKind) {
  const queryClient = useQueryClient()

  return async () => {
    const fresh = await api.get<AgentUsage>(`/api/agents/${agent}/usage?refresh=1`)
    queryClient.setQueryData(usageKey(agent), fresh)
  }
}
