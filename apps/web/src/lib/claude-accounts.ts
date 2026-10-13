import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ClaudeAccount, ClaudeAccountListDto, ClaudeLoginStatusDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Comptes Claude supplémentaires du compte courant.
 *
 * Comme pour les accès git, aucun hook ne lit un jeton : l'API n'en rend aucun. La
 * liste sert au sélecteur de compte du composer, qui ne montre la catégorie que s'il y
 * a quelque chose à choisir.
 */

const ACCOUNTS_KEY = ['claude-accounts']

export function useClaudeAccounts(enabled = true) {
  return useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: () => api.get<ClaudeAccountListDto>('/api/claude-accounts'),
    enabled,
    // La liste ne bouge que depuis l'écran de réglages, qui l'invalide lui-même.
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
      // Une consommation lue sous l'ancien jeton ne décrit plus forcément le même compte.
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
 * Connexion guidée d'un abonnement : le serveur pilote `claude setup-token`, l'écran
 * montre l'URL, recueille le code que la page affiche et le transmet. Le compte naît
 * quand le CLI a imprimé le jeton.
 */
const loginKey = (loginId: string) => ['claude-accounts', 'login', loginId]

export function useStartClaudeLogin() {
  return useMutation({
    mutationFn: (input: { label: string }) =>
      api.post<ClaudeLoginStatusDto>('/api/claude-accounts/login', input),
  })
}

export function useClaudeLoginStatus(loginId: string | null) {
  return useQuery({
    queryKey: loginKey(loginId ?? ''),
    queryFn: () => api.get<ClaudeLoginStatusDto>(`/api/claude-accounts/login/${encodeURIComponent(loginId ?? '')}`),
    enabled: loginId !== null,
    // Le CLI peut s'arrêter de lui-même (délai, erreur) : on le relit tant qu'il attend.
    refetchInterval: (query) =>
      query.state.data?.state === 'waiting_code' || query.state.data?.state === 'starting' ? 3000 : false,
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
