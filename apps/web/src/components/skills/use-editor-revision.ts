import { useEffect, useRef, useState } from 'react'

/**
 * Revision for CodeEditor text changed elsewhere. Editors read contents on mount to preserve
 * cursor/undo, but server updates would otherwise leave old text that Ctrl+S overwrites. Remount
 * when server text differs from display only without drafts; never replace ongoing edits.
 */
export function useEditorRevision(serverText: string | null, hasDraft: boolean) {
  /** Displayed editor text: initial contents then keystrokes. */
  const shown = useRef(serverText)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (serverText === null || hasDraft || serverText === shown.current) return
    // First received text is mount content, requiring no remount.
    const loaded = shown.current !== null
    shown.current = serverText
    if (loaded) setRevision((value) => value + 1)
  }, [serverText, hasDraft])

  return {
    revision,
    /** Call on every keystroke. */
    track: (text: string) => {
      shown.current = text
    },
    /** Discard drafts and restart from server text. */
    reset: () => {
      shown.current = serverText
      setRevision((value) => value + 1)
    },
  }
}
