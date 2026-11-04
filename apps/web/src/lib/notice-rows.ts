import type { NoticeItem } from './chat-fold'
import type { ChatRow } from './tool-rows'

export interface NoticeEntry {
  item: NoticeItem
  occurrences: number
}
export type NoticeRow = { kind: 'notice-group'; key: string; level: 'info' | 'warning'; entries: NoticeEntry[] }

/** Keep the journal intact; collapse only identical warnings in this rendered thread. */
export function compactNoticeRows(rows: ChatRow[]): (ChatRow | NoticeRow)[] {
  const result: (ChatRow | NoticeRow)[] = []
  const warnings = new Map<string, NoticeEntry>()
  for (const row of rows) {
    if (row.kind !== 'item' || row.item.kind !== 'notice' || !row.item.level) {
      result.push(row)
      continue
    }
    const item = row.item
    // Codes often describe an entire category. Different text or details must remain accessible.
    const identity = JSON.stringify([item.code, item.text, item.translation, item.details])
    const previous = item.level === 'warning' ? warnings.get(identity) : undefined
    if (previous) {
      previous.occurrences++
      continue
    }
    const entry = { item, occurrences: 1 }
    if (item.level === 'warning') warnings.set(identity, entry)
    const last = result.at(-1)
    if (last?.kind === 'notice-group' && last.level === item.level) last.entries.push(entry)
    else result.push({ kind: 'notice-group', key: row.key, level: item.level!, entries: [entry] })
  }
  return result
}
