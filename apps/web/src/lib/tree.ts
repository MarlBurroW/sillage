import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import type { TreeListingDto, TreeSearchDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Un niveau de l'arborescence du workspace.
 *
 * Une requête par dossier déplié, et non un arbre complet : `node_modules` seul pèse
 * des mégaoctets. Chaque niveau garde sa propre entrée de cache, donc replier puis
 * redéplier n'interroge pas le serveur à nouveau.
 *
 * `enabled` plutôt qu'un appel conditionnel : le nombre de hooks doit rester constant
 * d'un rendu à l'autre.
 */
export function useTreeLevel(conversationId: string, path: string, enabled: boolean) {
  return useQuery({
    queryKey: ['tree', conversationId, path],
    queryFn: () =>
      api.get<TreeListingDto>(
        `/api/conversations/${conversationId}/tree?path=${encodeURIComponent(path)}`,
      ),
    enabled,
    // L'arborescence change quand l'agent écrit, pas toute seule : le rafraîchissement
    // est déclenché par la fin d'un tour et par le bouton, jamais par un sondage.
    staleTime: Infinity,
  })
}

/**
 * Recherche d'un fichier par son nom, dans tout le répertoire de travail.
 *
 * Requête distincte de l'arborescence : celle-ci est paginée par niveau, chercher
 * demande de traverser. Désactivée sous deux caractères, où la liste ne discrimine
 * rien et où la marche coûte le plus cher.
 */
export function useFileSearch(conversationId: string, query: string) {
  const trimmed = query.trim()
  return useQuery({
    queryKey: ['tree-search', conversationId, trimmed],
    queryFn: () =>
      api.get<TreeSearchDto>(
        `/api/conversations/${conversationId}/tree/search?q=${encodeURIComponent(trimmed)}`,
      ),
    enabled: trimmed.length >= 2,
    staleTime: 30_000,
  })
}

/** Invalide tous les niveaux ouverts d'une conversation, d'un coup. */
export function useRefreshTree(conversationId: string): () => void {
  const queryClient = useQueryClient()
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['tree', conversationId] })
  }, [queryClient, conversationId])
}
