import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useSyncExternalStore } from 'react'
import { DEFAULT_SESSION_VIEWS, type SessionView, type UserSettingsDto } from '@sillage/protocol'
import { api } from './api'
import { translate, type MessageKey } from './i18n'
import { USER_SETTINGS_KEY, useUserSettings } from './user-settings'

const PRESET_NAMES: Record<NonNullable<SessionView['preset']>, MessageKey> = {
  attention: 'wall.preset.attention',
  running: 'wall.preset.running',
  unread: 'wall.preset.unread',
  recent: 'wall.preset.recent',
}

/** Built-in views keep their translated name until renamed. Pass `useTranslate()` from components. */
export function viewName(view: SessionView, t: (key: MessageKey) => string = translate): string {
  return view.name ?? (view.preset ? t(PRESET_NAMES[view.preset]) : view.query)
}

/** Saved wall views, or the built-in ones until the account changes any. */
export function useSessionViews(): { views: SessionView[]; loading: boolean } {
  const { data, isLoading } = useUserSettings()
  return { views: data?.sessionViews ?? DEFAULT_SESSION_VIEWS, loading: isLoading }
}

/**
 * Replace the whole list, applied before the reply like collapsed projects: tabs and pins must
 * react at once. The server reply stays authoritative.
 */
export function useSaveSessionViews() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sessionViews: SessionView[]) => api.patch<UserSettingsDto>('/api/me/settings', { sessionViews }),
    onMutate: async (sessionViews) => {
      await queryClient.cancelQueries({ queryKey: USER_SETTINGS_KEY })
      const previous = queryClient.getQueryData<UserSettingsDto>(USER_SETTINGS_KEY)
      if (previous) queryClient.setQueryData(USER_SETTINGS_KEY, { ...previous, sessionViews })
      return { previous }
    },
    onError: (_error, _views, context) => {
      if (context?.previous) queryClient.setQueryData(USER_SETTINGS_KEY, context.previous)
    },
    onSuccess: (settings) => queryClient.setQueryData(USER_SETTINGS_KEY, settings),
  })
}

export function newViewId(): string {
  return `view-${crypto.randomUUID()}`
}

/*
 * Sessions removed from a view by hand. Kept on this device only: it is a passing gesture, and
 * each removal lapses at the session's next activity anyway.
 */
const DISMISSED_KEY = 'sillage.wall.dismissed'
type Dismissed = Record<string, Record<string, number>>
const dismissListeners = new Set<() => void>()
let dismissedCache: { raw: string | null; value: Dismissed } = { raw: null, value: {} }

function readDismissed(): Dismissed {
  const raw = localStorage.getItem(DISMISSED_KEY)
  if (raw === dismissedCache.raw) return dismissedCache.value
  let value: Dismissed = {}
  try { value = raw ? (JSON.parse(raw) as Dismissed) : {} } catch { value = {} }
  dismissedCache = { raw, value }
  return value
}

function writeDismissed(next: Dismissed): void {
  localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
  for (const listener of dismissListeners) listener()
}

function subscribeDismissed(listener: () => void): () => void {
  dismissListeners.add(listener)
  return () => { dismissListeners.delete(listener) }
}

/** Removed sessions of one view, each with the activity time it was removed at. */
export function useDismissed(viewId: string): {
  dismissed: Record<string, number>
  dismiss: (conversationId: string, activityAt: number) => void
  restore: (conversationId: string) => void
} {
  const all = useSyncExternalStore(subscribeDismissed, readDismissed, readDismissed)
  const dismissed = all[viewId] ?? {}
  const dismiss = useCallback((conversationId: string, activityAt: number) => {
    const current = readDismissed()
    writeDismissed({ ...current, [viewId]: { ...current[viewId], [conversationId]: activityAt } })
  }, [viewId])
  const restore = useCallback((conversationId: string) => {
    const current = readDismissed()
    const { [conversationId]: _removed, ...rest } = current[viewId] ?? {}
    writeDismissed({ ...current, [viewId]: rest })
  }, [viewId])
  return { dismissed, dismiss, restore }
}
