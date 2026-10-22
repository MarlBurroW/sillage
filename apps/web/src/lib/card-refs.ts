import { createContext, useContext, useMemo } from 'react'
import type { CardDto } from '@sillage/protocol'
import { useCards } from './cards'

/**
 * Project whose cards rendered text may cite (`#12`). Supplied by screens knowing the project, such
 * as conversations and card details. Elsewhere (release notes, instructions), references have no
 * board and remain text.
 */
export const CardRefContext = createContext<string | null>(null)

/** Current project's citable cards by number; empty without context. */
export function useCardRefs(): { projectId: string | null; cards: Map<number, CardDto> } {
  const projectId = useContext(CardRefContext)
  // Board list already cached when navigating from it: one shared request per project for all thread messages.
  const { data } = useCards(projectId ?? undefined)
  const cards = useMemo(() => new Map((data ?? []).map((card) => [card.number, card])), [data])
  return { projectId, cards }
}

/** Card address: its project board with the detail drawer open. */
export function cardHref(projectId: string, number: number): string {
  return `/p/${projectId}/board?carte=${number}`
}
