/**
 * Largeur du tiroir de détail d'une carte, publiée en variable CSS.
 *
 * Séparée de celle du panneau d'outils d'une conversation (`sillage.sheetWidth`) parce
 * que les deux ne servent pas la même chose : celui-là doit loger un explorateur et un
 * éditeur côte à côte, celui-ci une description et une liste de sessions. Partager la
 * valeur ferait qu'élargir l'un élargit l'autre sans qu'on l'ait demandé.
 */

const WIDTH_KEY = 'sillage.cardPanelWidth'

/** En deçà, le titre d'une session et sa branche ne tiennent plus sur une ligne. */
const MIN_WIDTH = 280

/** Ce qui reste du board derrière le tiroir, pour qu'une colonne garde une prise. */
const MIN_BOARD = 200

function maxWidth(): number {
  return Math.max(MIN_WIDTH, window.innerWidth - MIN_BOARD)
}

/** Une colonne et demie : assez pour lire une description sans couvrir le board. */
function defaultWidth(): number {
  return Math.min(420, Math.round(window.innerWidth * 0.32))
}

/**
 * Écrit la largeur retenue et la renvoie, bornes appliquées.
 *
 * En variable CSS plutôt qu'en état React : le glissement émet un événement par image,
 * et re-rendre le board entier à chacun rendrait la poignée pâteuse. `persist` n'est
 * vrai qu'en fin de geste, une écriture par image dans `localStorage` étant synchrone.
 */
export function setCardPanelWidth(px: number, persist: boolean): number {
  const width = Math.round(Math.min(maxWidth(), Math.max(MIN_WIDTH, px)))
  document.documentElement.style.setProperty('--card-panel-width', `${width}px`)
  if (persist) localStorage.setItem(WIDTH_KEY, String(width))
  return width
}

export function restoreCardPanelWidth(): void {
  const stored = Number(localStorage.getItem(WIDTH_KEY))
  setCardPanelWidth(Number.isFinite(stored) && stored > 0 ? stored : defaultWidth(), false)
}
