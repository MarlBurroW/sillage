import { useSyncExternalStore } from 'react'
import { useMatch } from 'react-router-dom'

// A reading mode for this tab, independent of saved appearance and panel preferences.
let enabled = false
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function toggleConcentration(): void {
  enabled = !enabled
  for (const listener of listeners) listener()
}

export function useConcentration(): boolean {
  const active = useSyncExternalStore(subscribe, () => enabled, () => false)
  const conversation = useMatch('/p/:projectId/c/:conversationId')
  const discussion = useMatch('/discussions/:conversationId')
  return active && Boolean(conversation || discussion)
}
