import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DEFAULT_PROJECT_DEFAULTS, type AgentConfig, type AgentKind, type BoardOrder, type ComposerLayout, type NotificationPrefs, type OnboardingState, type ProjectDefaults, type UserSettingsDto } from '@sillage/protocol'
import { api } from './api'

const USER_SETTINGS_KEY = ['user-settings']

/** `enabled` pour les écrans montés avant la session : sans compte, la route répondrait 401. */
export function useUserSettings(enabled = true) {
  return useQuery({
    queryKey: USER_SETTINGS_KEY,
    queryFn: () => api.get<UserSettingsDto>('/api/me/settings'),
    enabled,
  })
}

/** Les défauts des projets à venir, ceux du protocole tant que le compte n'est pas lu. */
export function useProjectDefaults(): ProjectDefaults {
  const { data } = useUserSettings()
  return data?.projectDefaults ?? DEFAULT_PROJECT_DEFAULTS
}

/** Les deux défauts, remplacés en bloc et appliqués sans attendre : ce sont des cartes qu'on clique. */
export function useUpdateProjectDefaults() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (projectDefaults: ProjectDefaults) => api.patch<UserSettingsDto>('/api/me/settings', { projectDefaults }),
    onMutate: async (projectDefaults) => {
      await queryClient.cancelQueries({ queryKey: USER_SETTINGS_KEY })
      const previous = queryClient.getQueryData<UserSettingsDto>(USER_SETTINGS_KEY)
      if (previous) queryClient.setQueryData(USER_SETTINGS_KEY, { ...previous, projectDefaults })
      return { previous }
    },
    onError: (_error, _defaults, context) => {
      if (context?.previous) queryClient.setQueryData(USER_SETTINGS_KEY, context.previous)
    },
    onSuccess: (settings) => queryClient.setQueryData(USER_SETTINGS_KEY, settings),
  })
}

/**
 * L'ordre des colonnes d'un board, et de quoi le changer. Appliqué sans attendre : le
 * board se réordonne au clic, et revient si le serveur n'a pas pris le choix.
 */
export function useBoardOrder(projectId: string | undefined): [BoardOrder, (order: BoardOrder) => void] {
  const queryClient = useQueryClient()
  const { data } = useUserSettings()
  const update = useMutation({
    mutationFn: (order: BoardOrder) => api.patch<UserSettingsDto>('/api/me/settings', { boardOrder: { projectId, order } }),
    onMutate: async (order) => {
      await queryClient.cancelQueries({ queryKey: USER_SETTINGS_KEY })
      const previous = queryClient.getQueryData<UserSettingsDto>(USER_SETTINGS_KEY)
      if (previous && projectId) {
        queryClient.setQueryData(USER_SETTINGS_KEY, { ...previous, boardOrder: { ...previous.boardOrder, [projectId]: order } })
      }
      return { previous }
    },
    onError: (_error, _order, context) => {
      if (context?.previous) queryClient.setQueryData(USER_SETTINGS_KEY, context.previous)
    },
    onSuccess: (settings) => queryClient.setQueryData(USER_SETTINGS_KEY, settings),
  })
  const order = (projectId && data?.boardOrder[projectId]) || 'manual'
  return [order, (next) => update.mutate(next)]
}

/**
 * Les CLI masqués, remplacés en bloc et appliqués sans attendre : le rang disparaît au
 * clic, et revient tel quel si le serveur n'a pas pris le changement.
 */
export function useUpdateHiddenAgents() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (hiddenAgents: AgentKind[]) => api.patch<UserSettingsDto>('/api/me/settings', { hiddenAgents }),
    onMutate: async (hiddenAgents) => {
      await queryClient.cancelQueries({ queryKey: USER_SETTINGS_KEY })
      const previous = queryClient.getQueryData<UserSettingsDto>(USER_SETTINGS_KEY)
      if (previous) queryClient.setQueryData(USER_SETTINGS_KEY, { ...previous, hiddenAgents })
      return { previous }
    },
    onError: (_error, _agents, context) => {
      if (context?.previous) queryClient.setQueryData(USER_SETTINGS_KEY, context.previous)
    },
    onSuccess: (settings) => queryClient.setQueryData(USER_SETTINGS_KEY, settings),
  })
}

/**
 * L'état de la visite, remplacé en bloc et appliqué sans attendre : l'étape suivante
 * doit s'afficher au clic, pas après l'aller-retour qui la mémorise.
 */
export function useUpdateOnboarding() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (onboarding: OnboardingState) => api.patch<UserSettingsDto>('/api/me/settings', { onboarding }),
    onMutate: async (onboarding) => {
      await queryClient.cancelQueries({ queryKey: USER_SETTINGS_KEY })
      const previous = queryClient.getQueryData<UserSettingsDto>(USER_SETTINGS_KEY)
      if (previous) queryClient.setQueryData(USER_SETTINGS_KEY, { ...previous, onboarding })
      return { previous }
    },
    onError: (_error, _state, context) => {
      if (context?.previous) queryClient.setQueryData(USER_SETTINGS_KEY, context.previous)
    },
    onSuccess: (settings) => queryClient.setQueryData(USER_SETTINGS_KEY, settings),
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

/** Les sortes de notifications voulues, remplacées en bloc et appliquées sans attendre. */
export function useUpdateNotificationPrefs() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (notifications: NotificationPrefs) => api.patch<UserSettingsDto>('/api/me/settings', { notifications }),
    onMutate: async (notifications) => {
      await queryClient.cancelQueries({ queryKey: USER_SETTINGS_KEY })
      const previous = queryClient.getQueryData<UserSettingsDto>(USER_SETTINGS_KEY)
      if (previous) queryClient.setQueryData(USER_SETTINGS_KEY, { ...previous, notifications })
      return { previous }
    },
    onError: (_error, _prefs, context) => {
      if (context?.previous) queryClient.setQueryData(USER_SETTINGS_KEY, context.previous)
    },
    onSuccess: (settings) => queryClient.setQueryData(USER_SETTINGS_KEY, settings),
  })
}

/**
 * Les réglages épinglés sous le composer, remplacés en bloc et appliqués sans attendre :
 * une puce qui apparaît après un aller-retour réseau donnerait l'impression que
 * l'épingle n'a pas pris.
 */
export function useUpdateComposerLayout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (composerLayout: ComposerLayout) => api.patch<UserSettingsDto>('/api/me/settings', { composerLayout }),
    onMutate: async (composerLayout) => {
      await queryClient.cancelQueries({ queryKey: USER_SETTINGS_KEY })
      const previous = queryClient.getQueryData<UserSettingsDto>(USER_SETTINGS_KEY)
      if (previous) queryClient.setQueryData(USER_SETTINGS_KEY, { ...previous, composerLayout })
      return { previous }
    },
    onError: (_error, _layout, context) => {
      if (context?.previous) queryClient.setQueryData(USER_SETTINGS_KEY, context.previous)
    },
    onSuccess: (settings) => queryClient.setQueryData(USER_SETTINGS_KEY, settings),
  })
}
