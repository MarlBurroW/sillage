import type { SillageEvent } from '@sillage/protocol'

/** Entries made obsolete by later journal events during replay. Largest conversations spend most bytes on immediately superseded state: 73 of 102 MB, comprising 47 MB `tool.output_delta` replaced by final `tool.completed` output and 26 MB cumulative `diff.updated` patches where only the last displays. Filtering preserves identical fold state, verified by five largest conversations and `replay.test.ts`: omit tool deltas followed by completion of that call, respecting sequence positions so reused IDs do not erase active calls; omit intermediate diffs but retain first for card placement and last for contents, including mid-turn reconnects; retain only latest wholesale lists (`commands.updated`, `skills.updated`, `mcp.updated`). Every omission has a retained successor delivered later. Journals remain intact and live streaming bypasses filtering. */

/** Wholesale replacement lists: only the latest matters. */
const REPLACED = new Set<string>(['commands.updated', 'skills.updated', 'mcp.updated'])

/** Events after which folds open new diff cards (`diffId`). */
const DIFF_BOUNDARIES = new Set<string>(['turn.started', 'turn.completed'])

/** Only event types contributing to this index; other events have no effect. */
export const INDEXED_TYPES: SillageEvent['type'][] = [
  'tool.completed',
  'diff.updated',
  'turn.started',
  'turn.completed',
  'commands.updated',
  'skills.updated',
  'mcp.updated',
]

/** Minimal journal row for filtering decisions. Read `toolCallId` only for tools (`tool.completed` during indexing, `tool.output_delta` during replay); null elsewhere. */
export interface JournalRow {
  seq: number
  type: string
  toolCallId: string | null
}

export interface SupersessionIndex {
  /** Last covered `seq`; retain everything beyond unknown history. */
  seq: number
  /** Observed turn boundaries numbering diff turns. */
  turns: number
  /** Latest `tool.completed` for each call. */
  completed: Map<string, number>
  /** Turn for each `diff.updated`. */
  diffTurn: Map<number, number>
  /** First and last `diff.updated` per turn. */
  turnDiffs: Map<number, { first: number; last: number }>
  /** Latest `seq` for each wholesale list. */
  latest: Map<string, number>
}

export function emptySupersessionIndex(): SupersessionIndex {
  return {
    seq: 0,
    turns: 0,
    completed: new Map(),
    diffTurn: new Map(),
    turnDiffs: new Map(),
    latest: new Map(),
  }
}

/** Advances indexes through `throughSeq` using indexed-type rows between exclusive `index.seq` and inclusive `throughSeq` in journal order. Reprocessing rows would count turn boundaries twice and shift later diff turns. Incremental because journals only append, leaving indexed history unchanged. */
export function advanceIndex(index: SupersessionIndex, rows: JournalRow[], throughSeq: number): void {
  for (const row of rows) {
    if (row.type === 'tool.completed') {
      if (row.toolCallId !== null) index.completed.set(row.toolCallId, row.seq)
    } else if (DIFF_BOUNDARIES.has(row.type)) {
      index.turns += 1
    } else if (row.type === 'diff.updated') {
      index.diffTurn.set(row.seq, index.turns)
      const bounds = index.turnDiffs.get(index.turns)
      if (bounds) bounds.last = row.seq
      else index.turnDiffs.set(index.turns, { first: row.seq, last: row.seq })
    } else if (REPLACED.has(row.type)) {
      index.latest.set(row.type, row.seq)
    }
  }
  index.seq = Math.max(index.seq, throughSeq)
}

/** Whether later events make rows unnecessary to folds. */
export function isSuperseded(index: SupersessionIndex, row: JournalRow): boolean {
  if (row.seq > index.seq) return false

  if (row.type === 'tool.output_delta') {
    const completedAt = row.toolCallId === null ? undefined : index.completed.get(row.toolCallId)
    return completedAt !== undefined && completedAt > row.seq
  }

  if (row.type === 'diff.updated') {
    const turn = index.diffTurn.get(row.seq)
    const bounds = turn === undefined ? undefined : index.turnDiffs.get(turn)
    return bounds !== undefined && row.seq !== bounds.first && row.seq !== bounds.last
  }

  const latest = index.latest.get(row.type)
  return latest !== undefined && latest > row.seq
}
