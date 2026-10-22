import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { GrokAccount, GrokAccountListDto, GrokLoginStatusDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Additional Grok accounts for the current user. Grok handles login server-side: start it here,
 * display the code, and poll until complete. Hooks never see secrets; only API keys are sent
 * outbound.
 */

const ACCOUNTS_KEY = ['grok-accounts']
/** Outside `ACCOUNTS_KEY` for the same reason as Claude; see `claude-accounts.ts`. */
const loginKey = (id: string) => ['grok-login', id]

export function useGrokAccounts(enabled = true) {
  return useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: () => api.get<GrokAccountListDto>('/api/grok-accounts'),
    enabled,
    staleTime: 60 * 60 * 1000,
  })
}

export function useCreateGrokAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { label: string }) => api.post<GrokAccount>('/api/grok-accounts', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
  })
}

export function useRenameGrokAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      api.patch<void>(`/api/grok-accounts/${encodeURIComponent(id)}`, { label }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
  })
}

export function useDeleteGrokAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/grok-accounts/${encodeURIComponent(id)}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
  })
}

/**
 * Account login state polled every two seconds while awaiting code entry. The server detects
 * completion through `grok login` output.
 */
export function useGrokLoginStatus(id: string, watch: boolean) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: loginKey(id),
    queryFn: async () => {
      const status = await api.get<GrokLoginStatusDto>(`/api/grok-accounts/${encodeURIComponent(id)}/login`)
      // Polling detects Grok completion because device codes are entered elsewhere: the card must
      // show Connected without reload.
      if (status.state === 'done') {
        void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY })
        void queryClient.invalidateQueries({ queryKey: ['usage'] })
      }
      return status
    },
    refetchInterval: (query) => (watch || query.state.data?.state === 'pending' ? 2000 : false),
    staleTime: 0,
  })
}

export function useStartGrokLogin(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { type: 'deviceCode' } | { type: 'apiKey'; apiKey: string }) =>
      api.post<GrokLoginStatusDto>(`/api/grok-accounts/${encodeURIComponent(id)}/login`, input),
    onSuccess: (status) => {
      queryClient.setQueryData(loginKey(id), status)
      // API keys connect immediately: update the list without waiting.
      void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY })
      void queryClient.invalidateQueries({ queryKey: ['usage'] })
    },
  })
}

/** Cancel a pending code or disconnect a ready account through the same route. */
export function useStopGrokLogin(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.delete<void>(`/api/grok-accounts/${encodeURIComponent(id)}/login`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: loginKey(id) })
      void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY })
      void queryClient.invalidateQueries({ queryKey: ['usage'] })
    },
  })
}
