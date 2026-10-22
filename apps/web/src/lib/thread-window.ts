import type { ChatRow } from './tool-rows'

/**
 * Thread rendering window. Long conversations produce thousands of rows, costly both in initial DOM
 * mounting and full-thread React reconciliation on delta batches sixteen times per second. Only the
 * end is read, so mount only the end and let users request earlier content. The fold stays
 * complete: bound rendering, not state. Off-window rows still exist for turn navigation, just
 * outside the DOM.
 */

/** Enough to cover several turns at opening without mounting the entire thread. */
export const INITIAL_WINDOW_ROWS = 120

/** Load-earlier step, roughly the same size as the initial window. */
export const WINDOW_STEP_ROWS = 120

/** Margin above a newly revealed row so it is not flush against the thread's top edge with nothing above. */
const REVEAL_MARGIN_ROWS = 20

export interface ThreadWindow {
  /** Rows to mount, in thread order. */
  rows: ChatRow[]
  /** Rows omitted before the window. Zero when the whole thread is mounted. */
  hidden: number
}

function opensTurn(row: ChatRow): boolean {
  return row.kind === 'item' && row.item.kind === 'message' && row.item.role === 'user'
}

/**
 * Take the last `size` rows and extend to their containing turn's start: cutting mid-turn would
 * show an answer without its question. Bound extension by `size`: one turn can contain hundreds of
 * tool calls, so unbounded searching would restore the whole thread and defeat windowing.
 */
export function windowRows(rows: ChatRow[], size: number): ThreadWindow {
  if (!Number.isFinite(size) || rows.length <= size) return { rows, hidden: 0 }

  const raw = rows.length - size
  let start = raw
  for (let i = raw; i >= 0 && raw - i <= size; i -= 1) {
    const row = rows[i]
    if (row && opensTurn(row)) {
      start = i
      break
    }
  }

  if (start === 0) return { rows, hidden: 0 }
  return { rows: rows.slice(start), hidden: start }
}

/** Item position in the thread, or -1 if absent. */
export function rowIndexOfItem(rows: ChatRow[], itemId: string): number {
  return rows.findIndex((row) => {
    if (row.kind === 'item') return row.item.id === itemId
    if (row.kind === 'tool') return row.tool.id === itemId
    return row.tools.some((tool) => tool.id === itemId)
  })
}

/**
 * Window size needed to mount `itemId`, or null if absent. The caller never shrinks: take the
 * maximum with the current size or navigating to a recent turn would hide already expanded content.
 */
export function windowToReveal(rows: ChatRow[], itemId: string): number | null {
  const index = rowIndexOfItem(rows, itemId)
  if (index === -1) return null
  return rows.length - index + REVEAL_MARGIN_ROWS
}
