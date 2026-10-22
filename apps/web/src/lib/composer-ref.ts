import { useEffect, useRef } from 'react'

/**
 * Paths sent from the explorer to the composer. Use events rather than state: there is only a
 * gesture to transmit, nothing to retain. Referencing the same file twice must insert twice, which
 * last-path state cannot express. Outside React because endpoints live in different columns;
 * lifting state would propagate panel state into the thread.
 */
type Listener = (path: string) => void

const listeners = new Set<Listener>()

/** Insert `@path` into the open conversation's composer. */
export function referenceInComposer(path: string): void {
  for (const listener of listeners) listener(path)
}

export function useComposerReferences(onReference: Listener): void {
  useEffect(() => {
    listeners.add(onReference)
    return () => {
      listeners.delete(onReference)
    }
  }, [onReference])
}

/**
 * Suggested composer message: the CLI's next-turn suggestion accepted beneath the thread. Same
 * channel as paths for the same reason: suggestion and composer live separately with nothing to
 * retain between them.
 */
type TextListener = (text: string) => void

const prefillListeners = new Set<TextListener>()

export function prefillComposer(text: string): void {
  for (const listener of prefillListeners) listener(text)
}

/** Same subscription pattern as drops: register once and invoke the latest callback. */
export function useComposerPrefill(onPrefill: TextListener): void {
  const latest = useRef(onPrefill)
  latest.current = onPrefill

  useEffect(() => {
    const listener: TextListener = (text) => latest.current(text)
    prefillListeners.add(listener)
    return () => {
      prefillListeners.delete(listener)
    }
  }, [])
}

/**
 * Files dropped on the conversation. Same channel and rationale as paths: the gesture originates in
 * the thread, while the composer handles uploads. Dropping the same file twice must create two
 * attachments.
 */
type FileListener = (files: File[]) => void

const fileListeners = new Set<FileListener>()

export function dropInComposer(files: File[]): void {
  for (const listener of fileListeners) listener(files)
}

/**
 * Subscribe once but always invoke the latest callback: drop processing reads current attachments,
 * while a mount-time closure would see a stale count.
 */
export function useComposerDrops(onDrop: FileListener): void {
  const latest = useRef(onDrop)
  latest.current = onDrop

  useEffect(() => {
    const listener: FileListener = (files) => latest.current(files)
    fileListeners.add(listener)
    return () => {
      fileListeners.delete(listener)
    }
  }, [])
}
