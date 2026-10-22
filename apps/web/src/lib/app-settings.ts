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
    // The route returns complete state: set it directly to avoid another round-trip flash on a
    // single-field screen.
    onSuccess: (settings) => queryClient.setQueryData(APP_SETTINGS_KEY, settings),
  })
}

export function useRunArchivePass() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<ArchiveRunDto>('/api/settings/archiving/run', {}),
    // Archiving removes threads from the sidebar: invalidate or they would remain until reload.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['conversations'] }),
  })
}
