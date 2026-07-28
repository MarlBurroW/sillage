import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PushStatusDto } from '@sillage/protocol'
import { api } from './api'
import { translate } from './i18n'

const PUSH_KEY = ['push']

/**
 * Abonnement aux notifications système.
 *
 * Trois conditions doivent être réunies, et elles échouent chacune pour une raison
 * différente qu'il faut savoir distinguer : un service worker enregistré (donc HTTPS),
 * l'API Push disponible, et la permission accordée par l'utilisateur.
 */

export type PushAvailability = 'ok' | 'insecure' | 'unsupported'

/**
 * Ce que le navigateur permet ici.
 *
 * Hors contexte sécurisé, ni le service worker ni l'API Push n'existent : le distinguer
 * d'un navigateur qui ne les gère pas évite de dire « non supporté » à quelqu'un dont
 * le seul tort est d'être en `http://`.
 */
export function pushAvailability(): PushAvailability {
  if (!window.isSecureContext) return 'insecure'
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported'
  return 'ok'
}

/**
 * La clé publique voyage en base64url ; l'API en attend les octets.
 *
 * Le type de retour est `ArrayBuffer` et non `Uint8Array` : depuis que les tableaux
 * typés peuvent s'appuyer sur un `SharedArrayBuffer`, ils ne satisfont plus `BufferSource`.
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
      // `userVisibleOnly` est obligatoire : les navigateurs refusent un abonnement qui
      // permettrait de recevoir des messages sans rien montrer à l'utilisateur.
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeKey(publicKey),
      })

      await api.post('/api/push/subscribe', subscription.toJSON())
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PUSH_KEY }),
  })
}

export function useUnsubscribePush() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () => {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (!subscription) return

      // Le serveur d'abord : si le navigateur se désabonne et que l'appel échoue,
      // l'endpoint resterait en base et recevrait des envois voués à l'échec.
      await api.post('/api/push/unsubscribe', { endpoint: subscription.endpoint })
      await subscription.unsubscribe()
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PUSH_KEY }),
  })
}
