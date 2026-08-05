import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentConfig, UserSettingsDto } from '@sillage/protocol'
import { api } from './api'

const USER_SETTINGS_KEY = ['user-settings']

export function useUserSettings() {
  return useQuery({
    queryKey: USER_SETTINGS_KEY,
    queryFn: () => api.get<UserSettingsDto>('/api/me/settings'),
  })
}

/** Le défaut d'un CLI, remplacé en bloc : la route ne fusionne pas champ par champ. */
export function useUpdateAgentDefault() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (agentDefault: AgentConfig) =>
      api.patch<UserSettingsDto>('/api/me/settings', { agentDefault }),
    onSuccess: (settings) => queryClient.setQueryData(USER_SETTINGS_KEY, settings),
  })
}
