import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { GrokAccount, GrokAccountListDto, GrokLoginStatusDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Comptes Grok supplémentaires du compte courant.
 *
 * La connexion est menée par Grok côté serveur : ici on la lance, on affiche le code
 * à saisir, et on relit l'état jusqu'à ce qu'elle aboutisse. Aucun hook ne voit de
 * secret : seule la clé API part, à l'aller.
 */

const ACCOUNTS_KEY = ['grok-accounts']
/** Hors de `ACCOUNTS_KEY`, pour la même raison que côté Claude : voir `claude-accounts.ts`. */
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
 * L'état de la connexion d'un compte, relu toutes les deux secondes tant qu'un code
 * attend d'être saisi : c'est le serveur qui apprend la fin, par la sortie de `grok login`.
 */
export function useGrokLoginStatus(id: string, watch: boolean) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: loginKey(id),
    queryFn: async () => {
      const status = await api.get<GrokLoginStatusDto>(`/api/grok-accounts/${encodeURIComponent(id)}/login`)
      // C'est la relecture qui apprend que Grok a fini, le code d'appareil se saisissant
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

export function useStartGrokLogin(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { type: 'deviceCode' } | { type: 'apiKey'; apiKey: string }) =>
      api.post<GrokLoginStatusDto>(`/api/grok-accounts/${encodeURIComponent(id)}/login`, input),
    onSuccess: (status) => {
      queryClient.setQueryData(loginKey(id), status)
      // Une clé API connecte tout de suite : la liste doit le montrer sans attendre.
      void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY })
      void queryClient.invalidateQueries({ queryKey: ['usage'] })
    },
  })
}

/** Annule une attente de code, ou déconnecte un compte prêt : la même route pour les deux. */
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
