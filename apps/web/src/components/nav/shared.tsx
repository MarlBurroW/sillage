import { MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core'
import { useState } from 'react'
import { useMediaQuery } from '../../lib/viewport'

/**
 * Touch has no right click and long-press already starts row dragging: omit context menus; the
 * always-visible ellipsis button suffices.
 */
export function useContextMenuEnabled(): boolean {
  return !useMediaQuery('(pointer: coarse)')
}

/**
 * Suppress the click immediately following drag-and-drop. Capture before links, then remove on the
 * next event-loop tick: if no click follows the drag, never swallow the next legitimate one.
 */
export function swallowNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }

  window.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
}

/**
 * Rename field opened by double-clicking the name. Select text on opening because users usually
 * replace a CLI-suggested name; an end-position cursor forced manual deletion.
 */
export function RenameInput({
  value,
  onCommit,
  onCancel,
  className,
}: {
  value: string
  onCommit: (next: string) => void
  onCancel: () => void
  className: string
}) {
  const [draft, setDraft] = useState(value)

  return (
    <input
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onCommit(draft)
        if (event.key === 'Escape') onCancel()
      }}
      className={className}
    />
  )
}

/**
 * Mouse uses a movement threshold so link clicks remain clicks. Touch uses long-press so dragging
 * does not steal list scrolling.
 */
export function useDragSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  )
}
