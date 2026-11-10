/* Pure placement and sizing for the session wall, kept free of imports so tests can load it. */

export interface WallPlacement {
  /** View and query the placement answers; another one starts from scratch. */
  key: string
  ids: string[]
  /** Placed tiles that no longer match, kept until read. */
  away: string[]
}

/**
 * Where each tile goes. A new question (another view or an edited query) gets its answer in query
 * order at once. Within one question, tiles keep their slots and newcomers take the end, so the
 * grid never reshuffles under the reader; a tile that stops matching on its own stays, marked,
 * while `keepAway` says it still deserves attention.
 */
export function placeTiles(previous: WallPlacement | null, key: string, wanted: readonly string[], keepAway: (id: string) => boolean): WallPlacement {
  if (!previous || previous.key !== key) return { key, ids: [...wanted], away: [] }
  const want = new Set(wanted)
  const away = previous.ids.filter((id) => !want.has(id) && keepAway(id))
  const kept = previous.ids.filter((id) => want.has(id) || away.includes(id))
  const placed = new Set(kept)
  return { key, ids: [...kept, ...wanted.filter((id) => !placed.has(id))], away }
}

export type WallLayoutMode = 'auto' | '2' | '3' | '4'

/** Smallest useful tile; below it the grid scrolls instead of shrinking further. */
const MIN_TILE_HEIGHT = 260
const MIN_TILE_WIDTH = 300
const PHONE_WIDTH = 600

/**
 * Grid that fills the screen like a video call: 4 tiles in 2×2, 6 in 3×2. Columns maximize tile
 * size while keeping tiles wider than tall; past the minimum height the wall scrolls.
 */
export function wallLayout(count: number, width: number, height: number, mode: WallLayoutMode, gap = 12): { columns: number; rowHeight: number } {
  // Phones get one column of tall tiles: a grid of slivers would show nothing.
  if (width < PHONE_WIDTH) return { columns: 1, rowHeight: Math.max(MIN_TILE_HEIGHT, Math.min(440, Math.floor(height * 0.75))) }
  const options = mode === 'auto' ? [1, 2, 3, 4, 5] : [Number(mode)]
  let best = { columns: 1, rowHeight: MIN_TILE_HEIGHT, score: -1 }
  for (const columns of options) {
    if (mode === 'auto' && columns > Math.max(count, 1)) break
    const tileWidth = (width - gap * (columns - 1)) / columns
    if (mode === 'auto' && columns > 1 && tileWidth < MIN_TILE_WIDTH) continue
    const rows = Math.max(1, Math.ceil(count / columns))
    const tileHeight = (height - gap * (rows - 1)) / rows
    const usable = Math.max(tileHeight, MIN_TILE_HEIGHT)
    const score = Math.min(tileWidth, usable * 1.6) * (tileHeight >= MIN_TILE_HEIGHT ? 1 : 0.7)
    if (score > best.score) best = { columns, rowHeight: Math.floor(usable), score }
  }
  return { columns: best.columns, rowHeight: best.rowHeight }
}
