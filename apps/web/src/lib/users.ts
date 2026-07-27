import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UserDto } from '@sillage/protocol'
import { api } from './api'

const USERS_KEY = ['users']

export function useUsers(enabled: boolean) {
  return useQuery({
    queryKey: USERS_KEY,
    queryFn: () => api.get<UserDto[]>('/api/users'),
    enabled,
  })
}

export interface CreateUserInput {
  username: string
  displayName: string
  password: string
  isAdmin: boolean
}

export function useCreateUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateUserInput) => api.post<{ ok: true }>('/api/users', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }),
  })
}

export interface UpdateUserInput {
  username: string
  displayName: string
  isAdmin: boolean
  password: string
  /** Exigé pour changer son propre mot de passe, ignoré par un administrateur. */
  currentPassword: string
}

export function useUpdateUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Partial<UpdateUserInput>) =>
      api.patch<{ ok: true }>(`/api/users/${id}`, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: USERS_KEY })
      // Le compte courant est lu par une autre requête : modifier son propre profil
      // doit rafraîchir l'en-tête et la sidebar, pas seulement la liste d'admin.
      void queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
    },
  })
}

export function useDeleteUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/users/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }),
  })
}
