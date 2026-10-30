import { useSyncExternalStore } from 'react'

/**
 * Place to show when a file opens: a content search result points at a line. Held outside React
 * because the explorer requests it and the editor, mounted later once the file has loaded,
 * consumes it.
 */
export interface RevealTarget {
  line: number
  column: number
  length: number
}

const pending = new Map<string, RevealTarget>()
const listeners = new Set<() => void>()
const keyOf = (scope: string, path: string) => `${scope}\0${path}`

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function requestReveal(scope: string, path: string, target: RevealTarget): void {
  pending.set(keyOf(scope, path), target)
  emit()
}

export function clearReveal(scope: string, path: string): void {
  if (pending.delete(keyOf(scope, path))) emit()
}

export function useReveal(scope: string, path: string): RevealTarget | null {
  return useSyncExternalStore(subscribe, () => pending.get(keyOf(scope, path)) ?? null, () => null)
}
