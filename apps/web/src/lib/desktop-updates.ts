import { useSyncExternalStore } from 'react'
import type { DesktopBridge, DesktopUpdateState } from '@sillage/protocol'

declare global {
  interface Window {
    /** Posé par le preload de l'app de bureau (apps/desktop/src/preload.ts), absent ailleurs. */
    sillageDesktop?: DesktopBridge
  }
}

const bridge = typeof window === 'undefined' ? undefined : window.sillageDesktop

// Un seul abonnement pour toute l'interface : l'état vit dans le processus principal, ici
// on n'en garde que la dernière copie reçue.
let current: DesktopUpdateState | null = null
const listeners = new Set<() => void>()

function receive(state: DesktopUpdateState): void {
  current = state
  for (const listener of listeners) listener()
}

if (bridge) {
  bridge.updates.subscribe(receive)
  // Un changement arrivé entre-temps est plus récent que cette réponse.
  void bridge.updates.state().then((state) => {
    if (current === null) receive(state)
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export interface DesktopUpdates {
  /** Null le temps que le processus principal réponde. */
  state: DesktopUpdateState | null
  check(): Promise<void>
  /** Ferme l'app, installe la version prête et la rouvre. */
  install(): Promise<void>
}

/**
 * La mise à jour de l'app de bureau, que son processus principal mène seul ; null hors de
 * l'app, dans un navigateur, où c'est le serveur qui se met à jour (`useVersionInfo`).
 */
export function useDesktopUpdate(): DesktopUpdates | null {
  const state = useSyncExternalStore(subscribe, () => current, () => null)
  if (!bridge) return null
  return { state, check: () => bridge.updates.check(), install: () => bridge.updates.install() }
}
