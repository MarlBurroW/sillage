import { parseSessionMessage } from '@sillage/protocol'
import type { ChatItem, MessageItem } from './chat-fold'

/** Conversation turn represented by turn navigation. */
export interface TurnMarker {
  /** User message ID, also serving as the thread anchor. */
  id: string
  user: string
  assistant: string
}

/** Enough to recognize a hovered turn without creating an oversized tooltip. */
const EXCERPT_LENGTH = 140

function excerpt(message: MessageItem): string {
  const raw = message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
  // Summarize messages from another session by sender and body, excluding tags and model-facing notes.
  const peer = message.role === 'user' ? parseSessionMessage(raw) : null
  const text = (peer ? `[${peer.title || peer.from}] ${peer.body}` : raw)
    // Streaming buffers complete text until the message finishes; otherwise current turns appear
    // empty in navigation.
    .concat(message.streamingText)
    .replace(/\s+/g, ' ')
    .trim()

  return text.length <= EXCERPT_LENGTH ? text : `${text.slice(0, EXCERPT_LENGTH).trimEnd()}...`
}

/**
 * Split the thread into turns: every user message opens one and receives the following first
 * assistant reply. Ignore tool calls and permission requests: navigation locates exchanges rather
 * than detailing their internals.
 */
export function buildTurns(items: ChatItem[]): TurnMarker[] {
  const turns: TurnMarker[] = []

  for (const item of items) {
    if (item.kind !== 'message') continue
    // Subagent text lives in the panel, not the thread: citing it as the turn reply would target
    // text absent from the anchor.
    if (item.parentToolCallId) continue

    if (item.role === 'user') {
      turns.push({ id: item.id, user: excerpt(item), assistant: '' })
      continue
    }

    const current = turns[turns.length - 1]
    if (current && !current.assistant) current.assistant = excerpt(item)
  }

  return turns
}
