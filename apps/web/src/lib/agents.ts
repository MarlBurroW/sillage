import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  PREFERRED_CLI_RELEASES,
  isCompatibleVersion,
  type AgentAvailabilityDto,
  type AgentAvailabilityListDto,
  type AgentEffortDto,
  type AgentKind,
  type AgentModelDto,
  type AgentModelsDto,
} from '@sillage/protocol'
import { translate } from './i18n'
import { api } from './api'

/**
 * Présence et version des CLI sur la machine du serveur.
 *
 * Sillage ne transporte plus les binaires : un agent dont le CLI manque ne doit pas être
 * proposé, sans quoi l'utilisateur découvre l'absence à l'échec de son premier message.
 */
export function useAgentAvailability() {
  return useQuery({
    queryKey: ['agents', 'availability'],
    queryFn: () => api.get<AgentAvailabilityListDto>('/api/agents'),
    // La sonde lance un process par CLI présent. Un CLI ne s'installe pas pendant qu'on
    // remplit un formulaire, et le serveur a son propre cache derrière.
    staleTime: 60 * 1000,
    // Sauf pendant une installation : elle se termine côté serveur sans rien pousser, et
    // c'est le seul moment où l'état change tout seul.
    refetchInterval: (query) =>
      query.state.data?.agents.some((a) => a.install.status === 'running') ? 2000 : false,
  })
}

/**
 * Installe la version testée d'un CLI. Le serveur répond avant la fin ; c'est la sonde
 * qui dira que c'est fini, d'où l'invalidation immédiate plutôt qu'une attente.
 */
export function useInstallAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (agent: AgentKind) => api.post(`/api/agents/${agent}/install`, {}),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['agents', 'availability'] }),
  })
}

/**
 * Pourquoi un agent ne peut pas être choisi, en une phrase affichable. Null quand il
 * le peut.
 */
export function unavailableReason(entry: AgentAvailabilityDto | undefined): string | null {
  if (!entry || entry.installed) return null
  switch (entry.reason) {
    case 'disabled':
      return translate('agent.unavailable.disabled')
    case 'not_executable':
      return translate('agent.unavailable.notExecutable', { binary: entry.binary })
    default:
      return translate('agent.unavailable.notOnPath', { binary: entry.binary })
  }
}

/**
 * Écart entre la version installée et celle que Sillage vise, à afficher comme un
 * avertissement. Null quand elles sont compatibles, ou qu'il n'y a rien à comparer.
 *
 * L'écart n'empêche rien et ne grise aucune carte : il se signale, et l'installation de
 * la version visée reste offerte à côté.
 */
export function versionMismatch(entry: AgentAvailabilityDto | undefined): string | null {
  if (!entry?.installed || !entry.version) return null
  const preferred = PREFERRED_CLI_RELEASES[entry.agent].version
  // `null` vaut « illisible, donc rien à dire » : seul un faux avéré justifie d'alerter.
  if (isCompatibleVersion(entry.version, preferred) !== false) return null
  return translate('agent.version.mismatch', { installed: entry.version, preferred })
}

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
