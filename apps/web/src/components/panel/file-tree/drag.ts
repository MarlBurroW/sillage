import type { DragEvent } from 'react'
import { IS_MAC, type Picked } from './shared'

/** Drag transfer type carrying JSON entries: the whole selection when dragging a selected row. */
export const DRAG_TYPE = 'application/x-sillage-entries'

/** Hold Option on Mac or Ctrl elsewhere to copy instead of move, matching desktop behavior. */
export function copyModifier(event: { altKey: boolean; ctrlKey: boolean }): boolean {
  return IS_MAC ? event.altKey : event.ctrlKey
}

/** Entries dragged from the tree, or null for other drag kinds. */
export function readDragged(event: DragEvent, scope: string): Picked[] | null {
  const raw = event.dataTransfer.getData(DRAG_TYPE)
  if (!raw) return null
  try {
    // A drag from another window may carry the same relative paths in a different folder.
    const payload = JSON.parse(raw) as { scope: string; entries: Picked[] }
    return payload.scope === scope && Array.isArray(payload.entries) ? payload.entries : null
  } catch {
    return null
  }
}

/**
 * Multi-entry count badge under the drag cursor: the default image shows only the grabbed row and
 * misleadingly suggests it moves alone.
 */
export function setDragBadge(event: DragEvent, label: string): void {
  const badge = document.createElement('div')
  badge.textContent = label
  badge.style.cssText =
    'position:fixed;top:-100px;left:0;padding:2px 8px;border-radius:6px;font:12px system-ui;' +
    'background:var(--sg-accent);color:var(--sg-accent-ink)'
  document.body.append(badge)
  event.dataTransfer.setDragImage(badge, -8, -8)
  // The image is captured immediately; remove its element on the next tick.
  setTimeout(() => badge.remove())
}
