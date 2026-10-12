import { useSyncExternalStore } from 'react'
import type { InAppNotification } from '@sillage/protocol'

/**
 * Les toasts de l'application : une décision, ou un CLI qui attend ailleurs. Le serveur
 * ne les envoie qu'aux onglets visibles ; ils restent jusqu'à ce qu'on les traite ou les
 * écarte, une demande n'étant pas une information qu'on laisse filer en cinq secondes.
 */

export interface Toast {
  id: string
  notification: InAppNotification
  at: number
}

let toasts: Toast[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** La clé de ce que le toast annonce : la même décision ou conversation n'en garde qu'un. */
function keyOf(notification: InAppNotification): string {
  return notification.kind === 'decision' ? `decision:${notification.decisionId}` : `cli:${notification.conversationId}`
}

export function pushToast(notification: InAppNotification): void {
  const id = keyOf(notification)
  toasts = [...toasts.filter((toast) => toast.id !== id), { id, notification, at: Date.now() }]
  emit()
}

export function dismissToast(id: string): void {
  toasts = toasts.filter((toast) => toast.id !== id)
  emit()
}

/** Une décision tranchée ailleurs n'a plus de toast à montrer. */
export function dismissDecisionToasts(keep: Set<string>): void {
  const next = toasts.filter((toast) => toast.notification.kind !== 'decision' || keep.has(toast.notification.decisionId))
  if (next.length !== toasts.length) {
    toasts = next
    emit()
  }
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => toasts,
    () => toasts,
  )
}
