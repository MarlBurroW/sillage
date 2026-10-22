import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SecretListDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Instance secret storage. Hooks never read values because no route returns them: the API exposes
 * only names, dates, and usage locations. Management intentionally shows little; accept that rather
 * than pretend to display secrets.
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
