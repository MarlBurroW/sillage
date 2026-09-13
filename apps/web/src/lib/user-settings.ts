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

/**
 * Les projets repliés dans la sidebar.
 *
 * Appliqué localement avant la réponse : un chevron qui attend un aller-retour réseau
 * pour tourner donne une sidebar molle, alors que le repli est un geste qu'on répète.
 * La réponse du serveur fait ensuite foi, comme pour toute mutation.
 */
export function useUpdateCollapsedProjects() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (collapsedProjects: string[]) =>
      api.patch<UserSettingsDto>('/api/me/settings', { collapsedProjects }),

    onMutate: async (collapsedProjects) => {
      await queryClient.cancelQueries({ queryKey: USER_SETTINGS_KEY })
      const previous = queryClient.getQueryData<UserSettingsDto>(USER_SETTINGS_KEY)
      if (previous) {
        queryClient.setQueryData(USER_SETTINGS_KEY, { ...previous, collapsedProjects })
      }
      return { previous }
    },

    onError: (_error, _ids, context) => {
      // Le serveur n'a pas pris le repli : l'affichage doit redevenir ce qu'il connaît,
      // sinon un projet resterait fermé chez soi et ouvert au rechargement suivant.
      if (context?.previous) queryClient.setQueryData(USER_SETTINGS_KEY, context.previous)
    },

    onSuccess: (settings) => queryClient.setQueryData(USER_SETTINGS_KEY, settings),
  })
}
