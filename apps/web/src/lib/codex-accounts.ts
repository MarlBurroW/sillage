import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CodexAccount, CodexAccountListDto, CodexLoginStatusDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Comptes Codex supplémentaires du compte courant.
 *
 * La connexion est menée par Codex côté serveur : ici on la lance, on affiche le code
 * à saisir, et on relit l'état jusqu'à ce qu'elle aboutisse. Aucun hook ne voit de
 * secret : seule la clé API part, à l'aller.
 */

const ACCOUNTS_KEY = ['codex-accounts']
/** Hors de `ACCOUNTS_KEY`, pour la même raison que côté Claude : voir `claude-accounts.ts`. */
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
 * L'état de la connexion d'un compte, relu toutes les deux secondes tant qu'un code
 * attend d'être saisi : c'est le serveur qui apprend la fin, par l'app-server.
 */
export function useCodexLoginStatus(id: string, watch: boolean) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: loginKey(id),
    queryFn: async () => {
      const status = await api.get<CodexLoginStatusDto>(`/api/codex-accounts/${encodeURIComponent(id)}/login`)
      // C'est la relecture qui apprend que Codex a fini, le code d'appareil se saisissant
      // ailleurs : la carte doit passer à « Connecté » sans recharger la page.
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
      // Une clé API connecte tout de suite : la liste doit le montrer sans attendre.
      void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY })
      void queryClient.invalidateQueries({ queryKey: ['usage'] })
    },
  })
}

/** Annule une attente de code, ou déconnecte un compte prêt : la même route pour les deux. */
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
