import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AppSettingsDto, ArchiveRunDto } from '@sillage/protocol'
import { api } from './api'

const APP_SETTINGS_KEY = ['app-settings']

export function useAppSettings() {
  return useQuery({
    queryKey: APP_SETTINGS_KEY,
    queryFn: () => api.get<AppSettingsDto>('/api/settings'),
  })
}

export function useUpdateAppSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: Partial<AppSettingsDto>) =>
      api.patch<AppSettingsDto>('/api/settings', patch),
    // La route rend l'état complet : le poser directement évite le clignotement d'un
    // aller-retour de plus sur un écran qui n'a qu'un champ.
    onSuccess: (settings) => queryClient.setQueryData(APP_SETTINGS_KEY, settings),
  })
}

export function useRunArchivePass() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<ArchiveRunDto>('/api/settings/archiving/run', {}),
    // Le passage vide la sidebar de ce qu'il range : sans invalidation, les fils
    // archivés y resteraient jusqu'au prochain chargement.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['conversations'] }),
  })
}
