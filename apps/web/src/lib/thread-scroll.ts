/**
 * Endroit où l'on lisait un fil, par conversation.
 *
 * La page de conversation n'est pas remontée quand on passe d'un fil à l'autre : sans
 * mémoire extérieure, revenir sur une conversation qu'on avait laissée au milieu la
 * rouvrait ailleurs, et il fallait retrouver à la main où l'on en était.
 *
 * Le repère est un message, pas une hauteur : entre deux visites le fil a grandi, des
 * blocs se sont dépliés, la fenêtre de rendu a bougé, et un `scrollTop` mémorisé ne
 * désigne plus la même chose. Le décalage, lui, reste en pixels : il ne vaut que
 * quelques dizaines de pixels autour du message repéré.
 *
 * Volontairement non persisté, comme les brouillons : une position vieille de plusieurs
 * jours n'a plus rien à voir avec ce que la conversation est devenue, et rouvrir à la
 * fin est alors le bon défaut.
 */
export interface ThreadScroll {
  /**
   * Le fil suivait le direct. Il rouvre en bas quoi qu'il soit arrivé depuis, ce que
   * ne saurait pas faire un repère posé sur le dernier message connu.
   */
  atBottom: boolean
  /** Message le plus haut affiché, par son `seq`. Ignoré quand `atBottom`. */
  seq: number
  /** Distance entre le haut de ce message et le haut de la zone affichée. */
  offset: number
}

const AT_BOTTOM: ThreadScroll = { atBottom: true, seq: 0, offset: 0 }

const positions = new Map<string, ThreadScroll>()

export function readThreadScroll(conversationId: string): ThreadScroll {
  return positions.get(conversationId) ?? AT_BOTTOM
}

export function saveThreadScroll(conversationId: string, position: ThreadScroll): void {
  positions.set(conversationId, position.atBottom ? AT_BOTTOM : position)
}
