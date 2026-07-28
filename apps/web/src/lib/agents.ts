import { useQuery } from '@tanstack/react-query'
import type { AgentEffortDto, AgentKind, AgentModelDto, AgentModelsDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Modèles déclarés par le CLI installé, sous la forme commune du protocole. Rien
 * n'est codé en dur : mettre à jour le CLI suffit à faire apparaître ses nouveaux
 * modèles, sans toucher à Sillage.
 */
export function useAgentModels(agent: AgentKind, enabled = true) {
  return useQuery({
    queryKey: ['agents', agent, 'models'],
    queryFn: () => api.get<AgentModelsDto>(`/api/agents/${agent}/models`),
    // La sonde démarre un CLI : inutile de la relancer à chaque montage du composer,
    // et hors de question de la lancer pour une conversation d'un autre agent.
    staleTime: 60 * 60 * 1000,
    retry: false,
    enabled,
  })
}

/**
 * Niveaux d'effort du modèle sélectionné. Tous n'en ont pas (Haiku, par exemple) :
 * proposer un réglage sans effet serait un mensonge d'interface.
 */
export function effortsFor(models: AgentModelDto[] | undefined, value: string): AgentEffortDto[] {
  return models?.find((model) => model.value === value)?.efforts ?? []
}
