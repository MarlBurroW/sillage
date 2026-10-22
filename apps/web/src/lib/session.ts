import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CurrentUser } from '@sillage/protocol'
import { ApiRequestError, api } from './api'

export const ME_KEY = ['auth', 'me']

export function useCurrentUser() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await api.get<CurrentUser>('/api/auth/me')
      } catch (err) {
        // No session is the logged-out state, not an error to display.
        if (err instanceof ApiRequestError && err.status === 401) return null
        throw err
      }
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  })
}

export function useLogin() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (credentials: { username: string; password: string }) =>
      api.post<CurrentUser>('/api/auth/login', credentials),
    onSuccess: (user) => queryClient.setQueryData(ME_KEY, user),
  })
}

export function useLogout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<void>('/api/auth/logout'),
    onSuccess: () => {
      /*
       * Set logged-out state on the still-live session query. `queryClient.clear()` would remove it
       * rather than reset it, leaving App's observer attached to a vanished entry with its last
       * result: the app remained logged in with an account the server no longer recognized. Clear
       * everything else so logging into another account cannot briefly show the previous account's
       * projects and conversations.
       */
      queryClient.setQueryData(ME_KEY, null)
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== ME_KEY[0] })
    },
  })
}
