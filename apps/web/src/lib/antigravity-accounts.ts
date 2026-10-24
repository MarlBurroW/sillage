import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AntigravityAccount, AntigravityAccountListDto, AntigravityLoginStatusDto, StartAntigravityLogin } from '@sillage/protocol'
import { api } from './api'

/**
 * Additional Antigravity accounts for the current user. Antigravity handles login server-side: start it here,
 * open the Google authorization URL and poll until complete. Tokens never return; API keys are sent
 * outbound.
 */

const ACCOUNTS_KEY = ['antigravity-accounts']
/** Outside `ACCOUNTS_KEY` for the same reason as Claude; see `claude-accounts.ts`. */
const loginKey = (id: string) => ['antigravity-login', id]

export function useAntigravityAccounts(enabled = true) {
  return useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: () => api.get<AntigravityAccountListDto>('/api/antigravity-accounts'),
    enabled,
    staleTime: 60 * 60 * 1000,
  })
}

export function useCreateAntigravityAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { label: string }) => api.post<AntigravityAccount>('/api/antigravity-accounts', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
  })
}

export function useRenameAntigravityAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      api.patch<void>(`/api/antigravity-accounts/${encodeURIComponent(id)}`, { label }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
  })
}

export function useDeleteAntigravityAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/antigravity-accounts/${encodeURIComponent(id)}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
  })
}

/**
 * Poll native ACP authentication while Google approval is pending.
 */
export function useAntigravityLoginStatus(id: string, watch: boolean) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: loginKey(id),
    queryFn: async () => {
      const status = await api.get<AntigravityLoginStatusDto>(`/api/antigravity-accounts/${encodeURIComponent(id)}/login`)
      // Polling detects native OAuth completion in another browser: the card must
      // show Connected without reload.
      if (status.state === 'done') {
        void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY })
        void queryClient.invalidateQueries({ queryKey: ['usage'] })
        void queryClient.invalidateQueries({ queryKey: ['agents', 'antigravity'] })
      }
      return status
    },
    refetchInterval: (query) => (watch || query.state.data?.state === 'pending' ? 2000 : false),
    staleTime: 0,
  })
}

export function useStartAntigravityLogin(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: StartAntigravityLogin) =>
      api.post<AntigravityLoginStatusDto>(`/api/antigravity-accounts/${encodeURIComponent(id)}/login`, input),
    onSuccess: (status) => {
      queryClient.setQueryData(loginKey(id), status)
      // Reset cached identity while native authentication runs.
      void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY })
      void queryClient.invalidateQueries({ queryKey: ['usage'] })
      void queryClient.invalidateQueries({ queryKey: ['agents', 'antigravity'] })
    },
  })
}

/** Cancel pending authentication or disconnect a ready account through the same route. */
export function useStopAntigravityLogin(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.delete<void>(`/api/antigravity-accounts/${encodeURIComponent(id)}/login`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: loginKey(id) })
      void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY })
      void queryClient.invalidateQueries({ queryKey: ['usage'] })
      void queryClient.invalidateQueries({ queryKey: ['agents', 'antigravity'] })
    },
  })
}

export function useAntigravityCallback(id: string) {
  return useMutation({ mutationFn: (url: string) => api.post<void>(`/api/antigravity-accounts/${encodeURIComponent(id)}/callback`, { url }) })
}
