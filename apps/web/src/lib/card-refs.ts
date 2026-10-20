import { createContext, useContext, useMemo } from 'react'
import type { CardDto } from '@sillage/protocol'
import { useCards } from './cards'

/**
 * Le projet dont un texte rendu peut citer les cartes (`#12`).
 *
 * Fourni par les écrans qui savent de quel projet ils parlent : une conversation, le
 * détail d'une carte. Ailleurs (notes de version, consignes), un `#12` n'a pas de board
 * auquel se rapporter et reste du texte.
 */
export const CardRefContext = createContext<string | null>(null)

/** Les cartes citables du projet en cours, par numéro ; vide hors contexte. */
export function useCardRefs(): { projectId: string | null; cards: Map<number, CardDto> } {
  const projectId = useContext(CardRefContext)
  // La liste du board, déjà en cache quand on vient de lui : un seul appel par projet,
  // partagé par tous les messages du fil.
  const { data } = useCards(projectId ?? undefined)
  const cards = useMemo(() => new Map((data ?? []).map((card) => [card.number, card])), [data])
  return { projectId, cards }
}

/** L'adresse d'une carte : le board de son projet, tiroir ouvert sur elle. */
export function cardHref(projectId: string, number: number): string {
  return `/p/${projectId}/board?carte=${number}`
}
