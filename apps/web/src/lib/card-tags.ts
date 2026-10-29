import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CardTagCatalogDto } from '@sillage/protocol'
import { api } from './api'

const tagsKey = (projectId: string) => ['card-tags', projectId]

/**
 * Project tag catalog. Agents add tags while working, so it refreshes like the board does rather
 * than staying frozen at first load.
 */
export function useCardTags(projectId: string | undefined) {
  return useQuery({
    queryKey: tagsKey(projectId ?? ''),
    queryFn: () => api.get<CardTagCatalogDto>(`/api/projects/${projectId}/card-tags`),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  })
}

/**
 * Every catalog change answers with the new catalog. Renames, merges and deletions also change
 * the chips the board shows, so the cards are reread too.
 */
function useCatalogMutation<T>(projectId: string, request: (input: T) => Promise<CardTagCatalogDto>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: request,
    onSuccess: (catalog) => {
      queryClient.setQueryData(tagsKey(projectId), catalog)
      void queryClient.invalidateQueries({ queryKey: ['cards', projectId] })
    },
  })
}

export function useCreateCardTag(projectId: string) {
  return useCatalogMutation(projectId, (input: { name: string; color?: string; description?: string }) =>
    api.post<CardTagCatalogDto>(`/api/projects/${projectId}/card-tags`, input))
}

export function useUpdateCardTag(projectId: string) {
  return useCatalogMutation(projectId, ({ id, ...patch }: { id: string; name?: string; color?: string; description?: string }) =>
    api.patch<CardTagCatalogDto>(`/api/card-tags/${id}`, patch))
}

export function useMergeCardTag(projectId: string) {
  return useCatalogMutation(projectId, ({ id, into }: { id: string; into: string }) =>
    api.post<CardTagCatalogDto>(`/api/card-tags/${id}/merge`, { into }))
}

export function useDeleteCardTag(projectId: string) {
  return useCatalogMutation(projectId, (id: string) => api.delete<CardTagCatalogDto>(`/api/card-tags/${id}`))
}

export function useCardTagSettings(projectId: string) {
  return useCatalogMutation(projectId, (input: { agentsCanCreate: boolean }) =>
    api.put<CardTagCatalogDto>(`/api/projects/${projectId}/card-tags/settings`, input))
}
