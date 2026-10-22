import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DEFAULT_PROJECT_DEFAULTS, type AgentConfig, type AgentKind, type BoardOrder, type ComposerLayout, type NotificationPrefs, type OnboardingState, type ProjectDefaults, type UserSettingsDto } from '@sillage/protocol'
import { api } from './api'

const USER_SETTINGS_KEY = ['user-settings']

/** Use `enabled` for screens mounted before login: the route returns 401 without an account. */
export function useUserSettings(enabled = true) {
  return useQuery({
    queryKey: USER_SETTINGS_KEY,
    queryFn: () => api.get<UserSettingsDto>('/api/me/settings'),
    enabled,
  })
}

/** Defaults for future projects, using protocol defaults until the account loads. */
export function useProjectDefaults(): ProjectDefaults {
  const { data } = useUserSettings()
  return data?.projectDefaults ?? DEFAULT_PROJECT_DEFAULTS
}

/** Replace both defaults atomically and apply immediately because they are clickable cards. */
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
 * Board column order and its updater. Apply immediately so the board reorders on click, reverting
 * on server rejection.
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
 * Replace hidden CLIs atomically and apply immediately: rows disappear on click and return
 * unchanged if rejected.
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
 * Replace onboarding state atomically and apply immediately: show the next step on click instead of
 * waiting for the persistence round trip.
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

/** Replace a CLI's defaults atomically: the route does not merge individual fields. */
export function useUpdateAgentDefault() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (agentDefault: AgentConfig) =>
      api.patch<UserSettingsDto>('/api/me/settings', { agentDefault }),
    onSuccess: (settings) => queryClient.setQueryData(USER_SETTINGS_KEY, settings),
  })
}

/**
 * Collapsed sidebar projects. Apply locally before the reply: waiting a round trip to rotate a
 * frequently used chevron makes the sidebar feel sluggish. The server reply is authoritative as
 * with every mutation.
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
      // Server rejected the collapse: restore known state or the project would be closed now and reopen on reload.
      if (context?.previous) queryClient.setQueryData(USER_SETTINGS_KEY, context.previous)
    },

    onSuccess: (settings) => queryClient.setQueryData(USER_SETTINGS_KEY, settings),
  })
}

/** Replace requested notification types atomically and apply immediately. */
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
 * Replace composer-pinned settings atomically and apply immediately: chips appearing a round trip
 * later would make pinning look unsuccessful.
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
