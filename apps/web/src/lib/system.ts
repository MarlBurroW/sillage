import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UpdateStatus, VersionInfo } from '@sillage/protocol'
import { api } from './api'
import { useDesktopUpdate } from './desktop-updates'
import { useCurrentUser } from './session'

const VERSION_KEY = ['system', 'version']
const UPDATE_KEY = ['system', 'update']

const versionQuery = {
  queryKey: VERSION_KEY,
  queryFn: () => api.get<VersionInfo>('/api/system/version'),
  // Le serveur cache déjà la réponse GitHub une heure : inutile de le solliciter
  // à chaque navigation dans les réglages.
  staleTime: 30 * 60 * 1000,
}

export function useVersionInfo() {
  return useQuery(versionQuery)
}

/**
 * Vrai quand une mise à jour attend un administrateur : seul lui peut la lancer,
 * les autres comptes n'ont pas à être relancés. La barre latérale s'en sert, donc
 * la vérification part dès l'ouverture de l'application et plus seulement quand on
 * visite les réglages ; le cache serveur borne toujours GitHub à une requête par heure.
 *
 * L'app de bureau se met à jour seule : elle ne fait signe qu'une fois la version
 * téléchargée, prête à installer. Quand elle ne peut pas le faire elle-même, ou qu'elle
 * a échoué, c'est la release publiée qui compte, à télécharger à la main.
 */
export function useUpdateNotice(): boolean {
  const { data: user } = useCurrentUser()
  const isAdmin = user?.isAdmin === true
  const { data } = useQuery({ ...versionQuery, enabled: isAdmin })
  const desktop = useDesktopUpdate()
  if (!isAdmin) return false
  if (desktop) {
    const status = desktop.state?.status
    if (status !== 'unsupported' && status !== 'error') return status === 'ready'
  }
  return data?.updateAvailable === true
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
