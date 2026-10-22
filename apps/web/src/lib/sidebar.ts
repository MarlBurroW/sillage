import { useSyncExternalStore } from 'react'

/**
 * Side navigation state shared outside React. Collapse is read by the shell and header-bearing
 * views: the restore button overlays their top-left corner and needs reserved space. Use a store
 * rather than context, as with theme, because these views are not in the sidebar's branch.
 */

const HIDDEN_KEY = 'sillage.sidebarHidden'
const WIDTH_KEY = 'sillage.sidebarWidth'
const DETAILED_KEY = 'sillage.sidebarDetailed'

/**
 * Below this width conversation titles lack useful line space; above it navigation occupies more
 * space than its destinations.
 */
const MIN_WIDTH = 200
const MAX_WIDTH = 480

let hidden = localStorage.getItem(HIDDEN_KEY) === '1'
let detailed = localStorage.getItem(DETAILED_KEY) === '1'
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSidebarHidden(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hidden,
    () => false,
  )
}

export function setSidebarHidden(next: boolean): void {
  if (next === hidden) return
  hidden = next
  localStorage.setItem(HIDDEN_KEY, next ? '1' : '0')
  for (const listener of listeners) listener()
}

/**
 * Detailed conversation rows: counts, usage, context, and model beneath the title. One switch for
 * the whole list allows comparison, unlike per-row expansion. Stored here because shell and mobile
 * drawer render the list from separate branches.
 */
export function useSidebarDetailed(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => detailed,
    () => false,
  )
}

export function setSidebarDetailed(next: boolean): void {
  if (next === detailed) return
  detailed = next
  localStorage.setItem(DETAILED_KEY, next ? '1' : '0')
  for (const listener of listeners) listener()
}

/**
 * Desktop width published as a CSS variable rather than React state. Dragging emits an event per
 * frame; rerendering the shell and all conversations each time would lag. `persist` is true only on
 * release because `localStorage` writes are synchronous. Returns the actual clamped width.
 */
export function setSidebarWidth(px: number, persist: boolean): number {
  const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px)))
  document.documentElement.style.setProperty('--sidebar-desktop-width', `${width}px`)
  if (persist) localStorage.setItem(WIDTH_KEY, String(width))
  return width
}

/** Restore chosen width. Without a saved value, write nothing: CSS remains the sole source of the default. */
export function restoreSidebarWidth(): void {
  const stored = Number(localStorage.getItem(WIDTH_KEY))
  if (Number.isFinite(stored) && stored > 0) setSidebarWidth(stored, false)
}
