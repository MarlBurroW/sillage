import { useSyncExternalStore } from 'react'
import type { InAppNotification } from '@sillage/protocol'

/**
 * App toasts for decisions or CLIs awaiting input elsewhere. The server sends only to visible tabs;
 * retain until handled or dismissed because requests must not disappear like five-second
 * informational messages. The exception is this tab's own news that needs nothing from the reader,
 * such as an action that succeeded: it leaves by itself.
 */

/** How an action run launched from this tab ended. Local to the tab, unlike server notifications. */
export interface ActionRunNotice {
  kind: 'actionRun'
  actionId: string
  projectId: string
  label: string
  outcome: 'succeeded' | 'failed' | 'interrupted' | 'serviceFailed' | 'serviceStopped'
  exitCode: number | null
  /** Terminal holding the output; null for a systemd unit, whose journal opens instead. */
  terminalId: string | null
  durationMs: number
}

export type ToastNotice = InAppNotification | ActionRunNotice

export interface Toast {
  id: string
  notification: ToastNotice
  at: number
}

let toasts: Toast[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Key identifying the announced item: keep only one toast per decision or conversation. */
function keyOf(notification: ToastNotice): string {
  if (notification.kind === 'actionRun') return `action:${notification.actionId}`
  if (notification.kind === 'decision') return `decision:${notification.decisionId}`
  if (notification.kind === 'usageLimit') return `limit:${notification.conversationId}`
  if (notification.kind === 'credentialExpiry') return `expiry:${notification.agent}`
  if (notification.kind === 'scheduleFailed') return `schedule:${notification.taskId}`
  return `cli:${notification.conversationId}`
}

export function pushToast(notification: ToastNotice, options?: { ttlMs?: number }): void {
  const id = keyOf(notification)
  const toast = { id, notification, at: Date.now() }
  toasts = [...toasts.filter((existing) => existing.id !== id), toast]
  emit()
  if (options?.ttlMs) {
    // Only this toast: a newer one under the same key keeps its own lifetime.
    setTimeout(() => {
      if (!toasts.includes(toast)) return
      toasts = toasts.filter((existing) => existing !== toast)
      emit()
    }, options.ttlMs)
  }
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
