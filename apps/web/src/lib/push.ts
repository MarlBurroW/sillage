import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PushDeviceDto, PushStatusDto, PushTestDto } from '@sillage/protocol'
import { api } from './api'
import { wsClient } from './ws-client'
import { translate } from './i18n'

const PUSH_KEY = ['push']

/**
 * System notification subscription. Three independent prerequisites have distinct failure reasons:
 * a registered service worker (thus HTTPS), Push API availability, and user permission.
 */

export type PushAvailability = 'ok' | 'insecure' | 'unsupported'

/**
 * Browser capabilities in this context. In insecure contexts neither service workers nor Push
 * exist: distinguish this from an unsupported browser rather than blaming support when the issue is
 * HTTP.
 */
export function pushAvailability(): PushAvailability {
  if (!window.isSecureContext) return 'insecure'
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported'
  return 'ok'
}

/**
 * Public keys travel as base64url; the API expects bytes. Return `ArrayBuffer` rather than
 * `Uint8Array`: typed arrays can now wrap `SharedArrayBuffer` and no longer satisfy `BufferSource`.
 */
function decodeKey(base64url: string): ArrayBuffer {
  const padded = base64url.padEnd(base64url.length + ((4 - (base64url.length % 4)) % 4), '=')
  const binary = atob(padded.replaceAll('-', '+').replaceAll('_', '/'))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return bytes.buffer as ArrayBuffer
}

export function usePushStatus(enabled: boolean) {
  return useQuery({
    queryKey: PUSH_KEY,
    queryFn: () => api.get<PushStatusDto>('/api/push'),
    enabled,
  })
}

export function useSubscribePush() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (publicKey: string) => {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        throw new Error(
          permission === 'denied'
            ? translate('push.permission.blocked')
            : translate('push.permission.denied'),
        )
      }

      const registration = await navigator.serviceWorker.ready
      // `userVisibleOnly` is mandatory: browsers reject subscriptions allowing messages without
      // visible user notifications.
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeKey(publicKey),
      })

      await api.post('/api/push/subscribe', subscription.toJSON())
      wsClient.setPushEndpoint(subscription.endpoint)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PUSH_DEVICES_KEY })
      return queryClient.invalidateQueries({ queryKey: PUSH_KEY })
    },
  })
}

export function useUnsubscribePush() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () => {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (!subscription) return

      // Server first: unsubscribing in the browser before a failed API call would leave a database
      // endpoint receiving doomed deliveries.
      await api.post('/api/push/unsubscribe', { endpoint: subscription.endpoint })
      await subscription.unsubscribe()
      wsClient.setPushEndpoint(null)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PUSH_DEVICES_KEY })
      return queryClient.invalidateQueries({ queryKey: PUSH_KEY })
    },
  })
}

const PUSH_DEVICES_KEY = ['push-devices']

/** Subscribed account devices and this device among them. */
export function usePushDevices(enabled: boolean) {
  return useQuery({
    queryKey: PUSH_DEVICES_KEY,
    queryFn: async () => {
      const { devices } = await api.get<{ devices: PushDeviceDto[] }>('/api/push/devices')
      const current = await currentEndpoint()
      return { devices, current }
    },
    enabled,
  })
}

async function currentEndpoint(): Promise<string | null> {
  if (!('serviceWorker' in navigator)) return null
  try {
    // Use `getRegistration`, not `ready`: without a registered service worker, `ready` never
    // resolves and the screen would wait forever.
    const registration = await navigator.serviceWorker.getRegistration()
    return (await registration?.pushManager?.getSubscription())?.endpoint ?? null
  } catch {
    return null
  }
}

export function useRemovePushDevice() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (endpoint: string) => api.post<void>('/api/push/devices/remove', { endpoint }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PUSH_KEY })
      return queryClient.invalidateQueries({ queryKey: PUSH_DEVICES_KEY })
    },
  })
}

/** A test notification after a delay allowing the app to close, tracked through its result. */
export function useSendPushTest() {
  return useMutation({
    mutationFn: (delaySeconds: number) => api.post<PushTestDto>('/api/push/test', { delaySeconds }),
  })
}

export function usePushTest(id: string | null) {
  return useQuery({
    queryKey: ['push-test', id],
    queryFn: () => api.get<PushTestDto>(`/api/push/test/${id}`),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data?.deliveries ? false : 1_000),
  })
}
