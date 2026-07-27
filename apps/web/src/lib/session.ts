import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CurrentUser } from '@sillage/protocol'
import { ApiRequestError, api } from './api'

const ME_KEY = ['auth', 'me']

export function useCurrentUser() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await api.get<CurrentUser>('/api/auth/me')
      } catch (err) {
        // Pas de session : ce n'est pas une erreur à afficher, c'est l'état déconnecté.
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
    onSuccess: () => queryClient.clear(),
  })
}
