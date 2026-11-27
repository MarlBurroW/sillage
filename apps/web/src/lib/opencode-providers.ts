import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { OpencodeProviderListDto } from '@sillage/protocol'
import { api } from './api'

/**
 * OpenCode model providers, for administrators: a connection serves the whole machine. The key
 * goes to the server once and never comes back; the list carries names and IDs only.
 */

const PROVIDERS_KEY = ['opencode-providers']
/** The model catalog lists what connected providers offer: it follows each change. */
const MODELS_KEY = ['agents', 'opencode', 'models']

export function useOpencodeProviders(enabled = true) {
  return useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => api.get<OpencodeProviderListDto>('/api/opencode/providers'),
    enabled,
    // Each read starts an OpenCode server: keep it for the visit, refresh after changes.
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

function useProviderMutation<T>(run: (input: T) => Promise<void>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY })
      void queryClient.invalidateQueries({ queryKey: MODELS_KEY })
    },
  })
}

export function useConnectOpencodeKey() {
  return useProviderMutation(({ provider, key, label }: { provider: string; key: string; label?: string }) =>
    api.post<void>(`/api/opencode/providers/${encodeURIComponent(provider)}/key`, { key, ...(label ? { label } : {}) }))
}

export function useDisconnectOpencodeCredential() {
  return useProviderMutation((credentialId: string) =>
    api.delete<void>(`/api/opencode/credentials/${encodeURIComponent(credentialId)}`))
}
