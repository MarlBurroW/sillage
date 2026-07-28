import type { ChatRow } from './tool-rows'

/**
 * Fenêtre d'affichage du fil.
 *
 * Une conversation longue produit des milliers de lignes, et les monter toutes coûte
 * deux fois : le DOM à poser à l'ouverture, puis la réconciliation React de tout le fil
 * à chaque lot de deltas, seize fois par seconde pendant un tour. Seule la fin est lue,
 * donc seule la fin est montée, et le début se demande.
 *
 * Le fold, lui, reste complet : c'est le rendu qu'on borne, pas l'état. Une ligne hors
 * fenêtre existe toujours, elle n'est simplement pas dans le DOM, ce qui suffit à ce que
 * la réglette des tours et la navigation puissent la viser.
 */

/** Assez pour couvrir plusieurs tours à l'ouverture, sans monter un fil entier. */
export const INITIAL_WINDOW_ROWS = 120

/** Pas d'un « afficher le début » : le même ordre de grandeur que la fenêtre initiale. */
export const WINDOW_STEP_ROWS = 120

/**
 * Marge conservée au-dessus d'une ligne qu'on vient de dévoiler, pour qu'elle n'arrive
 * pas collée au bord haut du fil avec le vide au-dessus.
 */
const REVEAL_MARGIN_ROWS = 20

export interface ThreadWindow {
  /** Lignes à monter, dans l'ordre du fil. */
  rows: ChatRow[]
  /** Lignes laissées avant la fenêtre. Zéro quand le fil est monté en entier. */
  hidden: number
}

function opensTurn(row: ChatRow): boolean {
  return row.kind === 'item' && row.item.kind === 'message' && row.item.role === 'user'
}

/**
 * Découpe les `size` dernières lignes, en remontant jusqu'au début du tour qui les
 * contient : couper au milieu d'un tour montrerait une réponse sans la question.
 *
 * La remontée est bornée par `size` : un seul tour peut porter des centaines d'appels
 * d'outils, et chercher son ouverture sans limite ramènerait le fil entier, ce que la
 * fenêtre est justement là pour éviter.
 */
export function windowRows(rows: ChatRow[], size: number): ThreadWindow {
  if (!Number.isFinite(size) || rows.length <= size) return { rows, hidden: 0 }

  const raw = rows.length - size
  let start = raw
  for (let i = raw; i >= 0 && raw - i <= size; i -= 1) {
    const row = rows[i]
    if (row && opensTurn(row)) {
      start = i
      break
    }
  }

  if (start === 0) return { rows, hidden: 0 }
  return { rows: rows.slice(start), hidden: start }
}

/** Position d'un élément dans le fil, ou -1 s'il n'y figure pas. */
export function rowIndexOfItem(rows: ChatRow[], itemId: string): number {
  return rows.findIndex((row) => {
    if (row.kind === 'item') return row.item.id === itemId
    if (row.kind === 'tool') return row.tool.id === itemId
    return row.tools.some((tool) => tool.id === itemId)
  })
}

/**
 * Taille de fenêtre nécessaire pour que `itemId` soit monté, ou null s'il n'est pas
 * dans le fil. L'appelant ne rétrécit jamais : il prend le maximum avec la taille
 * courante, sinon viser un tour récent replierait ce qu'on avait déjà déplié.
 */
export function windowToReveal(rows: ChatRow[], itemId: string): number | null {
  const index = rowIndexOfItem(rows, itemId)
  if (index === -1) return null
  return rows.length - index + REVEAL_MARGIN_ROWS
}
