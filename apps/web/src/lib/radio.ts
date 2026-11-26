import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RadioStationDto, UserSettingsDto } from '@sillage/protocol'
import { useSyncExternalStore } from 'react'
import { api } from './api'
import { USER_SETTINGS_KEY } from './user-settings'

/**
 * - tuning: switched on, the stream has not started yet;
 * - playing: sound is out;
 * - blocked: the browser refused to start sound without a gesture inside the player itself.
 */
export type RadioStatus = 'off' | 'tuning' | 'playing' | 'blocked'

// Never remembered: after a reload the browser would refuse to start sound on its own.
let status: RadioStatus = 'off'
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function setRadioStatus(next: RadioStatus): void {
  if (next === status) return
  status = next
  for (const listener of listeners) listener()
}

/** The stream never started: the browser waits for a gesture inside the player. */
export function radioStartTimedOut(): void {
  if (status === 'tuning') setRadioStatus('blocked')
}

export const toggleRadio = () => setRadioStatus(status === 'off' ? 'tuning' : 'off')

export function useRadio(): RadioStatus {
  return useSyncExternalStore(subscribe, () => status, () => status)
}

const STATION_KEY = ['radio'] as const

/** Also read while off: the rail names the station before it plays. */
export function useRadioStation() {
  return useQuery({
    queryKey: STATION_KEY,
    queryFn: () => api.get<RadioStationDto>('/api/radio'),
    staleTime: 10 * 60_000,
  })
}

/** `null` returns to Claude FM. A playing radio switches station without being turned off. */
export function useUpdateRadioUrl() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (radioUrl: string | null) => api.patch<UserSettingsDto>('/api/me/settings', { radioUrl }),
    onSuccess: (settings) => {
      queryClient.setQueryData(USER_SETTINGS_KEY, settings)
      void queryClient.invalidateQueries({ queryKey: STATION_KEY })
    },
  })
}
