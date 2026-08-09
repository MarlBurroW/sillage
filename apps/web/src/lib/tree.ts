import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect } from 'react'
import type { TreeListingDto, TreeSearchDto } from '@sillage/protocol'
import { api } from './api'
import { wsClient } from './ws-client'

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
  // Suivi sur le disque tant que ce niveau est affiché : c'est ce qui rattrape les
  // écritures que Sillage ne fait pas lui-même, celles d'un terminal du panneau comme
  // celles d'un éditeur ouvert à côté. Voir `useTreeSync` pour la relecture.
  useEffect(() => {
    if (!enabled) return
    return wsClient.watchTree(conversationId, path)
  }, [conversationId, path, enabled])

  return useQuery({
    queryKey: ['tree', conversationId, path],
    queryFn: () =>
      api.get<TreeListingDto>(
        `/api/conversations/${conversationId}/tree?path=${encodeURIComponent(path)}`,
      ),
    enabled,
    // Court plutôt qu'infini : la veille disque ne tient que pendant que le panneau est
    // ouvert, et un niveau remonté après un moment doit repartir du disque plutôt que
    // d'un cache figé. Assez long pour que replier et redéplier ne coûte rien.
    staleTime: 30_000,
  })
}

/**
 * Relit les niveaux que le serveur signale changés sur le disque.
 *
 * Posé une fois pour tout l'explorateur plutôt que par niveau : un abonné par dossier
 * déplié referait le travail que la clé de cache fait déjà.
 */
export function useTreeSync(conversationId: string): void {
  const queryClient = useQueryClient()
  useEffect(
    () =>
      wsClient.onTreeChanged((id, path) => {
        if (id !== conversationId) return
        void queryClient.invalidateQueries({ queryKey: ['tree', conversationId, path] })
      }),
    [queryClient, conversationId],
  )
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

/** Invalide tous les niveaux ouverts d'une conversation, et sa recherche, d'un coup. */
export function useRefreshTree(conversationId: string): () => void {
  const queryClient = useQueryClient()
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['tree', conversationId] })
    // La recherche est une requête à part, avec sa propre péremption : sans ça, une
    // liste de résultats gardait des fichiers déjà supprimés après le rafraîchissement.
    void queryClient.invalidateQueries({ queryKey: ['tree-search', conversationId] })
  }, [queryClient, conversationId])
}
