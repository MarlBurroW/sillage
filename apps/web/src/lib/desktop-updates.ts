import { useSyncExternalStore } from 'react'
import type { DesktopBridge, DesktopUpdateState } from '@sillage/protocol'

declare global {
  interface Window {
    /** Provided by the desktop preload; absent in browsers. */
    sillageDesktop?: DesktopBridge
  }
}

const bridge = typeof window === 'undefined' ? undefined : window.sillageDesktop

// Share one subscription across the UI; the main process owns the state.
let current: DesktopUpdateState | null = null
const listeners = new Set<() => void>()

function receive(state: DesktopUpdateState): void {
  current = state
  for (const listener of listeners) listener()
}

if (bridge) {
  bridge.updates.subscribe(receive)
  // An event received in the meantime is newer than this response.
  void bridge.updates.state().then((state) => {
    if (current === null) receive(state)
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export interface DesktopUpdates {
  /** Null until the main process responds. */
  state: DesktopUpdateState | null
  check(): Promise<void>
  /** Quit, install the ready version and relaunch. */
  install(): Promise<void>
}

/**
 * Desktop updates are owned by the main process. Browsers use server updates
 * (`useVersionInfo`), so this hook returns null outside the app.
 */
export function useDesktopUpdate(): DesktopUpdates | null {
  const state = useSyncExternalStore(subscribe, () => current, () => null)
  if (!bridge) return null
  return { state, check: () => bridge.updates.check(), install: () => bridge.updates.install() }
}
