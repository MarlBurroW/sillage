import { useLayoutEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { ConversationDto } from '@sillage/protocol'
import type { MarkdownSegment } from '../../lib/markdown'
import { SessionReference } from './SessionReference'

/**
 * Markdown owns the markup; React owns only empty reference slots. Portals preserve native links,
 * shared CLI icons and Radix's keyboard/touch behavior, including inside table cells.
 */
export function useSessionReferencePortals({ root, segments, sessions, loading }: {
  root: RefObject<HTMLDivElement | null>
  segments: MarkdownSegment[]
  sessions: Map<string, ConversationDto>
  loading: boolean
}) {
  const [slots, setSlots] = useState<HTMLElement[]>([])
  useLayoutEffect(() => {
    const found = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-sg-session-ref]') ?? [])
    setSlots(previous => previous.length === found.length && previous.every((slot, index) => slot === found[index]) ? previous : found)
  }, [root, segments])
  return slots.map((slot, index) => {
    const id = slot.dataset.sgSessionRef!
    return createPortal(<SessionReference id={id} conversation={sessions.get(id)} loading={loading} />, slot, `${id}-${index}`)
  })
}
