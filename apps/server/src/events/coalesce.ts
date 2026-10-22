import type { JournalEntry, SillageEvent } from '@sillage/protocol'

/** Groups deltas within replay pages. Token-level text produced nine thousand of twenty-six thousand events in one conversation, redundant after assembly. Rendering pays twice: `messageIndex` scans backward per fragment and `replaceItem` copies item arrays, making long replay quadratic. Dropping deltas would erase interrupted messages without `message.completed`: thirty-one observed examples were outside the last turn, defeating end-only heuristics. Merge instead: `message.delta` and `thinking.delta` append to `chat-fold.ts` buffers (`streamingText`, `streamingThinking`), so concatenated deltas produce identical state. Group per message to isolate interleaved main/subagent text while preserving fragment order. Retain the first fragment's `seq` and `ts` because folds use them as message start; advance replay cursors to the last read sequence, not last rendered sequence. Keep ascending `seq` order by retaining first-fragment positions, required by client idempotency guards. Live streams bypass this: merging only makes sense for persisted journals. */

type TextDelta = Extract<SillageEvent, { type: 'message.delta' | 'thinking.delta' }>

/** Only two event types whose fold appends text instead of replacing it. */
function textDelta(event: SillageEvent): TextDelta | null {
  return event.type === 'message.delta' || event.type === 'thinking.delta' ? event : null
}

export function coalesceDeltas(entries: JournalEntry[]): JournalEntry[] {
  const merged: JournalEntry[] = []
  const groupAt = new Map<string, number>()

  for (const entry of entries) {
    const delta = textDelta(entry.event)
    if (!delta) {
      merged.push(entry)
      continue
    }

    const key = `${delta.type} ${delta.messageId}`
    const at = groupAt.get(key)

    if (at === undefined) {
      groupAt.set(key, merged.length)
      merged.push(entry)
      continue
    }

    const open = merged[at] as JournalEntry & { event: TextDelta }
    merged[at] = {
      ...open,
      event: {
        ...open.event,
        text: open.event.text + delta.text,
        // Match fold rules: the first event naming a parent wins;
        // transcript resynchronization emitting `null` must not erase it.
        parentToolCallId: open.event.parentToolCallId ?? delta.parentToolCallId,
      },
    }
  }

  return merged
}
