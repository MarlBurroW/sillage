/**
 * Reading position per conversation. Conversation pages do not remount when switching threads;
 * without external memory, returning mid-thread opened elsewhere and required manually finding the
 * old position. Anchor to a message rather than height: new content, expanded blocks, and
 * rendering-window changes invalidate saved `scrollTop`. Keep only the nearby offset in pixels.
 * Deliberately not persisted, like drafts: days-old positions no longer reflect the conversation
 * and reopening at the bottom is then preferable.
 */
export interface ThreadScroll {
  /**
   * The thread was following live output. Reopen at the bottom regardless of new content, unlike an
   * anchor on the last known message.
   */
  atBottom: boolean
  /** Topmost displayed message by `seq`. Ignored when `atBottom`. */
  seq: number
  /** Distance from this message's top to the visible area's top. */
  offset: number
}

const AT_BOTTOM: ThreadScroll = { atBottom: true, seq: 0, offset: 0 }

const positions = new Map<string, ThreadScroll>()
const MAX_POSITIONS = 128

export function readThreadScroll(conversationId: string): ThreadScroll {
  const position = positions.get(conversationId)
  if (position) { positions.delete(conversationId); positions.set(conversationId, position) }
  return position ?? AT_BOTTOM
}

export function saveThreadScroll(conversationId: string, position: ThreadScroll): void {
  positions.delete(conversationId)
  positions.set(conversationId, position.atBottom ? AT_BOTTOM : position)
  if (positions.size > MAX_POSITIONS) positions.delete(positions.keys().next().value!)
}
