import { useCallback, useEffect, useState, type DragEvent } from 'react'
import { dropInComposer } from './composer-ref'

/**
 * Conversation file drops. Browsers normally open dropped files, replacing the page or opening a
 * tab: dropping a screenshot left the app instead of attaching it. The drop zone prevents this,
 * with a window guard elsewhere so missing the zone by a few pixels cannot lose the conversation.
 */

/** Whether the drag carries files rather than text or a link. */
function carriesFiles(transfer: DataTransfer | null): boolean {
  return transfer !== null && Array.from(transfer.types).includes('Files')
}

/**
 * Prevent the window opening files dropped outside the intended zone. Mount once per app. Preserve
 * useful nonfile drags, such as moving text into a field.
 */
export function useFileDropGuard(): void {
  useEffect(() => {
    const swallow = (event: globalThis.DragEvent) => {
      if (carriesFiles(event.dataTransfer)) event.preventDefault()
    }
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])
}

/**
 * Attributes for a file-accepting zone and its hover state. Count drag entries and exits rather
 * than toggling a boolean: crossing children emits parent `dragleave`, which would flash the
 * outline at every bubble.
 */
export function useFileDrop(enabled: boolean) {
  const [depth, setDepth] = useState(0)

  useEffect(() => {
    if (!enabled) setDepth(0)
  }, [enabled])

  const onDragEnter = useCallback(
    (event: DragEvent) => {
      if (!enabled || !carriesFiles(event.dataTransfer)) return
      event.preventDefault()
      setDepth((count) => count + 1)
    },
    [enabled],
  )

  const onDragOver = useCallback(
    (event: DragEvent) => {
      if (!enabled || !carriesFiles(event.dataTransfer)) return
      // Without hover `preventDefault`, the browser rejects the drop and uses its default behavior.
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    [enabled],
  )

  const onDragLeave = useCallback((event: DragEvent) => {
    if (!carriesFiles(event.dataTransfer)) return
    setDepth((count) => Math.max(0, count - 1))
  }, [])

  const onDrop = useCallback(
    (event: DragEvent) => {
      if (!enabled || !carriesFiles(event.dataTransfer)) return
      event.preventDefault()
      setDepth(0)

      const files = Array.from(event.dataTransfer.files)
      if (files.length > 0) dropInComposer(files)
    },
    [enabled],
  )

  return {
    dragging: depth > 0,
    handlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}
