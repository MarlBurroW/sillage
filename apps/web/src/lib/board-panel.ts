/**
 * Card detail drawer width published as a CSS variable. Separate from conversation tools
 * (`sillage.sheetWidth`): that panel needs explorer and editor side by side, while this drawer
 * needs description and sessions. Sharing would resize both when users adjust only one.
 */

const WIDTH_KEY = 'sillage.cardPanelWidth'

/** Below this width a session title and branch no longer fit on a line. */
const MIN_WIDTH = 480

/** Board space left behind the drawer so a column remains accessible. */
const MIN_BOARD = 200

function maxWidth(): number {
  return Math.max(MIN_WIDTH, window.innerWidth - MIN_BOARD)
}

/** A sheet wide enough for writing while preserving some visible board. */
function defaultWidth(): number {
  return Math.min(680, Math.round(window.innerWidth * 0.52))
}

/**
 * Write and return the clamped width. Use CSS rather than React state: dragging emits events per
 * frame, and rerendering the whole board would lag. `persist` is true only on release because
 * `localStorage` writes are synchronous.
 */
export function setCardPanelWidth(px: number, persist: boolean): number {
  const width = Math.round(Math.min(maxWidth(), Math.max(MIN_WIDTH, px)))
  document.documentElement.style.setProperty('--card-panel-width', `${width}px`)
  if (persist) localStorage.setItem(WIDTH_KEY, String(width))
  return width
}

export function restoreCardPanelWidth(): void {
  const stored = Number(localStorage.getItem(WIDTH_KEY))
  setCardPanelWidth(Number.isFinite(stored) && stored > 0 ? stored : defaultWidth(), false)
}
