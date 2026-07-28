import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UpdateStatus, VersionInfo } from '@sillage/protocol'
import { api } from './api'

const VERSION_KEY = ['system', 'version']
const UPDATE_KEY = ['system', 'update']

export function useVersionInfo() {
  return useQuery({
    queryKey: VERSION_KEY,
    queryFn: () => api.get<VersionInfo>('/api/system/version'),
    // Le serveur cache déjà la réponse GitHub une heure : inutile de le solliciter
    // à chaque navigation dans les réglages.
    staleTime: 30 * 60 * 1000,
  })
}

/** Rafraîchissement forcé (admin) : contourne le cache serveur d'une heure. */
export function useRefreshVersionInfo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.get<VersionInfo>('/api/system/version?refresh=1'),
    onSuccess: (info) => queryClient.setQueryData(VERSION_KEY, info),
  })
}

export function useStartUpdate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<UpdateStatus>('/api/system/update'),
    onSuccess: (status) => queryClient.setQueryData(UPDATE_KEY, status),
  })
}

/** Suivi d'une mise à jour en cours, par sondage : le serveur va redémarrer
 * et couper toute connexion persistante, un poll survit naturellement. */
export function useUpdateStatus(enabled: boolean) {
  return useQuery({
    queryKey: UPDATE_KEY,
    queryFn: () => api.get<UpdateStatus>('/api/system/update/status'),
    enabled,
    refetchInterval: 1000,
    // Pendant le redémarrage, les requêtes échouent : on garde le dernier état
    // connu à l'écran au lieu de basculer en erreur.
    retry: false,
    placeholderData: (previous) => previous,
  })
}
