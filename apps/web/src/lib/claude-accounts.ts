import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ClaudeAccount, ClaudeAccountListDto, ClaudeLoginStatusDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Additional Claude accounts for the current user. As with Git credentials, no hook reads a token
 * because the API never returns one. The composer displays the account category only when there is
 * a choice.
 */

const ACCOUNTS_KEY = ['claude-accounts']

export function useClaudeAccounts(enabled = true) {
  return useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: () => api.get<ClaudeAccountListDto>('/api/claude-accounts'),
    enabled,
    // The list changes only from settings, which invalidates it itself.
    staleTime: 60 * 60 * 1000,
  })
}

export function useCreateClaudeAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { label: string; token: string }) =>
      api.post<ClaudeAccount>('/api/claude-accounts', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
  })
}

export function useUpdateClaudeAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; label?: string; token?: string }) =>
      api.patch<void>(`/api/claude-accounts/${encodeURIComponent(id)}`, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY })
      // Usage read with the previous token may describe a different account.
      void queryClient.invalidateQueries({ queryKey: ['usage'] })
    },
  })
}

export function useDeleteClaudeAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/claude-accounts/${encodeURIComponent(id)}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
  })
}

/**
 * Guided subscription login: the server controls `claude setup-token`; the screen shows the URL,
 * collects the page's code, and forwards it. Create the account when the CLI prints its token.
 */
/**
 * Outside `ACCOUNTS_KEY`, not nested under it: invalidating the list would invalidate login
 * tracking, whose completion invalidates the list. This loop reached forty requests per second and
 * froze the screen on verification (October 13, 2026).
 */
const loginKey = (loginId: string) => ['claude-login', loginId]

export function useStartClaudeLogin() {
  return useMutation({
    mutationFn: (input: { label: string }) =>
      api.post<ClaudeLoginStatusDto>('/api/claude-accounts/login', input),
  })
}

export function useClaudeLoginStatus(loginId: string | null) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: loginKey(loginId ?? ''),
    queryFn: async () => {
      const status = await api.get<ClaudeLoginStatusDto>(`/api/claude-accounts/login/${encodeURIComponent(loginId ?? '')}`)
      // Polling detects completion; submitting a code merely forwards it. Newly created accounts
      // must appear without reload.
      if (status.state === 'done') {
        void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY })
        void queryClient.invalidateQueries({ queryKey: ['usage'] })
      }
      return status
    },
    enabled: loginId !== null,
    // The CLI may stop itself (timeout or error): poll while it waits and verifies a code, since
    // submission merely forwards it.
    refetchInterval: (query) =>
      query.state.data?.state === 'done' || query.state.data?.state === 'failed' ? false : 2000,
    staleTime: 0,
  })
}

export function useSubmitClaudeLoginCode(loginId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { code: string }) =>
      api.post<ClaudeLoginStatusDto>(`/api/claude-accounts/login/${encodeURIComponent(loginId ?? '')}/code`, input),
    onSuccess: (status) => {
      queryClient.setQueryData(loginKey(loginId ?? ''), status)
      if (status.state === 'done') void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY })
    },
  })
}

export function useCancelClaudeLogin() {
  return useMutation({
    mutationFn: (loginId: string) => api.delete<void>(`/api/claude-accounts/login/${encodeURIComponent(loginId)}`),
  })
}
