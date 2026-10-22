import { useSyncExternalStore } from 'react'
import type { InAppNotification } from '@sillage/protocol'

/**
 * App toasts for decisions or CLIs awaiting input elsewhere. The server sends only to visible tabs;
 * retain until handled or dismissed because requests must not disappear like five-second
 * informational messages.
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

/** Key identifying the announced item: keep only one toast per decision or conversation. */
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

/** A decision resolved elsewhere no longer needs a toast. */
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
