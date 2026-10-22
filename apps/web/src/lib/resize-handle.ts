import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'

/**
 * Width handle shared by the sidebar, side panel, card drawer, and explorer column. Only
 * pointer-position-to-width mapping differs: window left for sidebar, window right for panel and
 * drawer, container left for explorer. Window listeners, temporary cursor and text-selection
 * suppression, and persistence only on release were otherwise duplicated identically.
 */

/** Keyboard adjustment step: fine enough for precision, large enough for practical movement. */
const KEY_STEP_PX = 16

export interface ResizeHandle {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
}

export function resizeHandle({
  widthAt,
  current,
  apply,
}: {
  /** Desired width at this pointer x-coordinate. */
  widthAt: (clientX: number) => number
  /** Current width adjusted by keyboard when no pointer exists. `null` if unreadable. */
  current: () => number | null
  /**
   * `persist` is false during dragging: a gesture emits one event per frame and writing
   * `localStorage` every frame would make resizing sluggish.
   */
  apply: (width: number, persist: boolean) => void
}): ResizeHandle {
  return {
    onPointerDown: (event) => {
      event.preventDefault()

      const move = (moved: PointerEvent) => apply(widthAt(moved.clientX), false)
      const stop = (released: PointerEvent) => {
        apply(widthAt(released.clientX), true)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', stop)
        document.body.style.removeProperty('cursor')
        document.body.style.removeProperty('user-select')
      }

      // Listen on the window rather than the handle: a fast drag leaves the handle on its first
      // frame and must continue tracking.
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', stop)
      // Otherwise dragging selects underlying text and the cursor becomes an arrow outside the handle.
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },

    onKeyDown: (event) => {
      const arrow = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
      if (arrow === 0) return

      const width = current()
      if (width === null) return

      event.preventDefault()
      // Infer direction from `widthAt`: right-edge handles expand rightward, left-edge handles
      // leftward. Deriving it avoids repeating the direction at every call site and forgetting to
      // reverse it.
      const step = widthAt(1) > widthAt(0) ? arrow * KEY_STEP_PX : -arrow * KEY_STEP_PX
      apply(width + step, true)
    },
  }
}
