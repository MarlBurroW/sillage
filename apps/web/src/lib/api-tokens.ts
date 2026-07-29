import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentKind, ApiScope, ApiTokenDto, CreatedApiTokenDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Jetons d'API, ceux que présentent les clients machine.
 *
 * Le secret ne circule qu'une fois, dans la réponse à la création : aucun hook ne sait
 * le relire, parce qu'aucune route ne le rend. L'écran doit donc l'afficher sur-le-champ
 * ou le perdre.
 */

const TOKENS_KEY = ['api-tokens']

export function useApiTokens() {
  return useQuery({
    queryKey: TOKENS_KEY,
    queryFn: () => api.get<ApiTokenDto[]>('/api/tokens'),
  })
}

export interface CreateApiTokenInput {
  label: string
  scopes: ApiScope[]
  projectIds: string[]
  agent: AgentKind
  config: unknown
  expiresAt: number | null
}

export function useCreateApiToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateApiTokenInput) =>
      api.post<CreatedApiTokenDto>('/api/tokens', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TOKENS_KEY }),
  })
}

export function useRevokeApiToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.patch<ApiTokenDto>(`/api/tokens/${id}`, { revoked: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TOKENS_KEY }),
  })
}

export function useDeleteApiToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/tokens/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TOKENS_KEY }),
  })
}
