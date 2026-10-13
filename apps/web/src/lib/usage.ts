import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentKind, AgentUsage } from '@sillage/protocol'
import { api } from './api'

/** `account` est l'identifiant d'un compte Claude supplémentaire, null pour la connexion du CLI. */
const usageKey = (agent: AgentKind, account: string | null) => ['usage', agent, account]

const usagePath = (agent: AgentKind, account: string | null, refresh: boolean) => {
  const params = new URLSearchParams()
  if (account) params.set('account', account)
  if (refresh) params.set('refresh', '1')
  const query = params.toString()
  return `/api/agents/${agent}/usage${query ? `?${query}` : ''}`
}

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
 *
 * `enabled` sert aux appelants qui affichent la consommation sans qu'on l'ait demandée,
 * comme la page de brouillon : interroger un CLI absent ne rapporterait qu'une erreur.
 */
export function useAgentUsage(agent: AgentKind, enabled = true, account: string | null = null) {
  return useQuery({
    queryKey: usageKey(agent, account),
    queryFn: () => api.get<AgentUsage>(usagePath(agent, account, false)),
    enabled,
    staleTime: 0,
    // La consommation d'un compte n'a pas d'à-coups : réessayer en boucle ne ferait
    // que relancer des CLI pour rien.
    retry: false,
  })
}

/** Relecture explicite, qui court-circuite aussi le cache du serveur. */
export function useRefreshUsage(agent: AgentKind, account: string | null = null) {
  const queryClient = useQueryClient()

  return async () => {
    const fresh = await api.get<AgentUsage>(usagePath(agent, account, true))
    queryClient.setQueryData(usageKey(agent, account), fresh)
  }
}

/** Le compte Claude supplémentaire qu'une configuration désigne, null pour tout autre cas. */
export function usageAccountOf(config: { agent: AgentKind; account?: string | null } | null | undefined): string | null {
  return config?.agent === 'claude' ? (config.account ?? null) : null
}
