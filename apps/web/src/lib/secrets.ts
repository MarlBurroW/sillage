import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SecretListDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Dépôt de secrets de l'instance.
 *
 * Aucun hook ne lit une valeur, parce qu'aucune route n'en rend : l'API ne connaît que
 * des noms, des dates et des points d'emploi. C'est ce qui rend l'écran de gestion
 * volontairement pauvre, et il vaut mieux l'assumer que faire semblant d'afficher.
 */

const SECRETS_KEY = ['secrets']

export function useSecrets(enabled: boolean) {
  return useQuery({
    queryKey: SECRETS_KEY,
    queryFn: () => api.get<SecretListDto>('/api/secrets'),
    enabled,
  })
}

export function usePutSecret() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; value: string }) =>
      api.put<void>('/api/secrets', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SECRETS_KEY }),
  })
}

export function useDeleteSecret() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => api.delete<void>(`/api/secrets/${encodeURIComponent(name)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SECRETS_KEY }),
  })
}
