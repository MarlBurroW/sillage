import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CodexAccount, CodexAccountListDto, CodexLoginStatusDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Additional Codex accounts for the current user. Codex handles login server-side: start it here,
 * display the code, and poll until complete. Hooks never see secrets; only API keys are sent
 * outbound.
 */

const ACCOUNTS_KEY = ['codex-accounts']
/** Outside `ACCOUNTS_KEY` for the same reason as Claude; see `claude-accounts.ts`. */
const loginKey = (id: string) => ['codex-login', id]

export function useCodexAccounts(enabled = true) {
  return useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: () => api.get<CodexAccountListDto>('/api/codex-accounts'),
    enabled,
    staleTime: 60 * 60 * 1000,
  })
}

export function useCreateCodexAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { label: string }) => api.post<CodexAccount>('/api/codex-accounts', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
  })
}

export function useRenameCodexAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      api.patch<void>(`/api/codex-accounts/${encodeURIComponent(id)}`, { label }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
  })
}

export function useDeleteCodexAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/codex-accounts/${encodeURIComponent(id)}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
  })
}

/**
 * Account login state polled every two seconds while awaiting code entry. The server detects
 * completion through app-server.
 */
export function useCodexLoginStatus(id: string, watch: boolean) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: loginKey(id),
    queryFn: async () => {
      const status = await api.get<CodexLoginStatusDto>(`/api/codex-accounts/${encodeURIComponent(id)}/login`)
      // Polling detects Codex completion because device codes are entered elsewhere: the card must
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

export function useStartCodexLogin(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { type: 'deviceCode' } | { type: 'apiKey'; apiKey: string }) =>
      api.post<CodexLoginStatusDto>(`/api/codex-accounts/${encodeURIComponent(id)}/login`, input),
    onSuccess: (status) => {
      queryClient.setQueryData(loginKey(id), status)
      // API keys connect immediately: update the list without waiting.
      void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY })
      void queryClient.invalidateQueries({ queryKey: ['usage'] })
    },
  })
}

/** Cancel a pending code or disconnect a ready account through the same route. */
export function useStopCodexLogin(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.delete<void>(`/api/codex-accounts/${encodeURIComponent(id)}/login`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: loginKey(id) })
      void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY })
      void queryClient.invalidateQueries({ queryKey: ['usage'] })
    },
  })
}
