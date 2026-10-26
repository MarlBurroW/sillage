import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentConfig, ApiExecutionPolicy, AgentKind, ApiScope, ApiTokenDto, CreatedApiTokenDto } from '@sillage/protocol'
import { api } from './api'

/**
 * API tokens for machine clients. Secrets travel once in creation responses: no hook can reread
 * them because no route returns them. Screens must display them immediately or lose them.
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
  executionPolicy: ApiExecutionPolicy
  expiresAt: number | null
  webhookUrl: string | null
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

export function useUpdateApiTokenPermissions() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; executionPolicy: ApiExecutionPolicy; agent: AgentKind; config: AgentConfig }) =>
      api.patch<ApiTokenDto>(`/api/tokens/${id}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TOKENS_KEY }),
  })
}
