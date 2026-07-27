import { useQuery } from '@tanstack/react-query'
import type { FsListingDto } from '@sillage/protocol'
import { api } from './api'

export function useDirectoryListing(path: string | null, showHidden: boolean) {
  return useQuery({
    queryKey: ['fs', path, showHidden],
    queryFn: () => {
      const params = new URLSearchParams()
      if (path) params.set('path', path)
      if (showHidden) params.set('showHidden', 'true')
      return api.get<FsListingDto>(`/api/fs/browse?${params}`)
    },
    // Le disque bouge sous nos pieds : pas de cache long, mais on garde l'ancien
    // listing affiché pendant le chargement du suivant pour éviter le clignotement.
    staleTime: 5_000,
    placeholderData: (previous) => previous,
  })
}

/** Découpe un chemin absolu en segments cliquables pour le fil d'Ariane. */
export function breadcrumbSegments(path: string): { label: string; path: string }[] {
  const parts = path.split('/').filter(Boolean)
  return parts.map((label, index) => ({
    label,
    path: `/${parts.slice(0, index + 1).join('/')}`,
  }))
}
