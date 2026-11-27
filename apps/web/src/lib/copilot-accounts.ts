import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CopilotAccount, CopilotAccountListDto, CopilotLoginStatusDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Additional GitHub Copilot accounts for the current user. Copilot signs in server-side through a
 * device code: start it here, display the code, and poll until complete. No secret goes through
 * these hooks.
 */

const ACCOUNTS_KEY = ['copilot-accounts']
/** Outside `ACCOUNTS_KEY` for the same reason as Claude; see `claude-accounts.ts`. */
const loginKey = (id: string) => ['copilot-login', id]

export function useCopilotAccounts(enabled = true) {
  return useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: () => api.get<CopilotAccountListDto>('/api/copilot-accounts'),
    enabled,
    staleTime: 60 * 60 * 1000,
  })
}

export function useCreateCopilotAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { label: string }) => api.post<CopilotAccount>('/api/copilot-accounts', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
  })
}

export function useRenameCopilotAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      api.patch<void>(`/api/copilot-accounts/${encodeURIComponent(id)}`, { label }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
  })
}

export function useDeleteCopilotAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/copilot-accounts/${encodeURIComponent(id)}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
  })
}

/**
 * Account login state polled every two seconds while awaiting code entry. The server detects
 * completion when `copilot login` exits signed in.
 */
export function useCopilotLoginStatus(id: string, watch: boolean) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: loginKey(id),
    queryFn: async () => {
      const status = await api.get<CopilotLoginStatusDto>(`/api/copilot-accounts/${encodeURIComponent(id)}/login`)
      // Polling detects completion because device codes are entered elsewhere: the card must
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

export function useStartCopilotLogin(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<CopilotLoginStatusDto>(`/api/copilot-accounts/${encodeURIComponent(id)}/login`, {}),
    onSuccess: (status) => { queryClient.setQueryData(loginKey(id), status) },
  })
}

/** Cancel a pending code or disconnect a ready account through the same route. */
export function useStopCopilotLogin(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.delete<void>(`/api/copilot-accounts/${encodeURIComponent(id)}/login`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: loginKey(id) })
      void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY })
      void queryClient.invalidateQueries({ queryKey: ['usage'] })
    },
  })
}
