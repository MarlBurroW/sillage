/**
 * ↑ and ↓ in the composer walk back through what the user wrote, like a shell. Browsing starts only
 * from an empty field, so ↑ never replaces writing; it goes on while the field still holds the
 * recalled message unchanged and the caret sits on its first line (↑) or last line (↓), so moving
 * inside a multi-line message keeps working. Editing a recalled message ends browsing: it is a new
 * draft from then on.
 */

/** Position in the history being shown, or null when not browsing. */
export type Recall = number | null

export interface RecallMove {
  recall: Recall
  text: string
}

export function recallStep(
  key: 'ArrowUp' | 'ArrowDown',
  { history, recall, text, caretStart, caretEnd }: {
    history: string[]
    recall: Recall
    text: string
    caretStart: number
    caretEnd: number
  },
): RecallMove | null {
  if (history.length === 0 || caretStart !== caretEnd) return null
  const current = recall !== null && history[recall] === text ? recall : null
  if (current === null && text.length > 0) return null

  if (key === 'ArrowUp') {
    if (current !== null && text.slice(0, caretStart).includes('\n')) return null
    const index = current !== null ? current - 1 : history.length - 1
    // At the oldest message: stay, rather than letting the caret jump to the start.
    if (index < 0) return { recall: current, text }
    return { recall: index, text: history[index]! }
  }

  if (current === null) return null
  if (text.slice(caretEnd).includes('\n')) return null
  const index = current + 1
  // Past the newest message: back to the empty field browsing started from.
  if (index >= history.length) return { recall: null, text: '' }
  return { recall: index, text: history[index]! }
}
