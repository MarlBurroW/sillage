import { useQuery } from '@tanstack/react-query'
import { api } from './api'

export interface FileMatchDto {
  /** Chemin relatif au répertoire de travail, tel qu'il s'écrit après le `@`. */
  path: string
  name: string
}

/**
 * Fichiers proposés pour une mention.
 *
 * La requête est portée par le projet et non par la conversation : la barre de saisie
 * complète déjà les mentions sur une conversation qui n'existe pas encore.
 */
export function useFileSuggestions(
  projectId: string | undefined,
  worktreeId: string | null,
  query: string | null,
) {
  return useQuery({
    queryKey: ['files', projectId, worktreeId, query],
    queryFn: async () => {
      const params = new URLSearchParams({ q: query ?? '' })
      if (worktreeId) params.set('worktreeId', worktreeId)
      const result = await api.get<{ files: FileMatchDto[] }>(
        `/api/projects/${projectId}/files?${params}`,
      )
      return result.files
    },
    enabled: Boolean(projectId) && query !== null,
    // La liste des fichiers ne bouge pas à la seconde : inutile de la relire à chaque
    // frappe sur un préfixe déjà demandé.
    staleTime: 15_000,
  })
}
