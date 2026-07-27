import { useQuery } from '@tanstack/react-query'
import type {
  ClaudeModelDto,
  ClaudeModelsDto,
  CodexModelDto,
  CodexModelsDto,
} from '@sillage/protocol'
import { api } from './api'

/**
 * Modèles déclarés par le CLI installé. Rien n'est codé en dur : mettre à jour Claude
 * Code suffit à faire apparaître ses nouveaux modèles, sans toucher à Sillage.
 */
export function useClaudeModels() {
  return useQuery({
    queryKey: ['agents', 'claude', 'models'],
    queryFn: () => api.get<ClaudeModelsDto>('/api/agents/claude/models'),
    // La sonde démarre un CLI : inutile de la relancer à chaque montage du composer.
    staleTime: 60 * 60 * 1000,
    retry: false,
  })
}

/**
 * Niveaux d'effort du modèle sélectionné. Tous n'en ont pas (Haiku, par exemple) :
 * proposer un réglage sans effet serait un mensonge d'interface.
 */
export function effortLevelsFor(
  models: ClaudeModelDto[] | undefined,
  value: string,
): ClaudeModelDto['supportedEffortLevels'] {
  return models?.find((model) => model.value === value)?.supportedEffortLevels ?? []
}

/** Même contrat que pour Claude : les modèles viennent du CLI, jamais d'une liste figée. */
export function useCodexModels() {
  return useQuery({
    queryKey: ['agents', 'codex', 'models'],
    queryFn: () => api.get<CodexModelsDto>('/api/agents/codex/models'),
    staleTime: 60 * 60 * 1000,
    retry: false,
  })
}

/**
 * Niveaux d'effort du modèle Codex sélectionné. Le protocole les déclare en chaîne
 * libre, ils varient donc d'un modèle à l'autre.
 */
export function codexEffortsFor(
  models: CodexModelDto[] | undefined,
  model: string,
): { value: string; description: string }[] {
  return models?.find((m) => m.model === model)?.supportedReasoningEfforts ?? []
}
