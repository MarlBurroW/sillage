import { useSyncExternalStore } from 'react'

/**
 * État de la navigation latérale, partagé hors de React.
 *
 * Le repli est lu par la coque, qui le referme, et par les vues qui ont un en-tête :
 * le bouton de réaffichage se pose par-dessus leur coin haut-gauche, et sans place
 * réservée il recouvrirait leur contenu. Un magasin plutôt qu'un contexte, comme pour
 * le thème : ces vues ne sont pas dans la même branche que la sidebar.
 */

const HIDDEN_KEY = 'sillage.sidebarHidden'
const WIDTH_KEY = 'sillage.sidebarWidth'

/**
 * En deçà, un titre de conversation ne tient plus sur une ligne utile ; au-delà, la
 * navigation prend plus de place que ce qu'elle sert à atteindre.
 */
const MIN_WIDTH = 200
const MAX_WIDTH = 480

let hidden = localStorage.getItem(HIDDEN_KEY) === '1'
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSidebarHidden(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hidden,
    () => false,
  )
}

export function setSidebarHidden(next: boolean): void {
  if (next === hidden) return
  hidden = next
  localStorage.setItem(HIDDEN_KEY, next ? '1' : '0')
  for (const listener of listeners) listener()
}

/**
 * Largeur sur grand écran, publiée en variable CSS plutôt que remontée en état React.
 *
 * Le glissement émet un événement par image : re-rendre la coque et toute la liste des
 * conversations à chacun rendrait la poignée pâteuse. `persist` n'est vrai qu'en fin de
 * geste, une écriture par image dans `localStorage` étant synchrone.
 *
 * Renvoie la largeur réellement retenue, bornes appliquées.
 */
export function setSidebarWidth(px: number, persist: boolean): number {
  const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px)))
  document.documentElement.style.setProperty('--sidebar-desktop-width', `${width}px`)
  if (persist) localStorage.setItem(WIDTH_KEY, String(width))
  return width
}

/**
 * Rétablit la largeur choisie. Sans valeur enregistrée, rien n'est écrit : la largeur
 * par défaut reste celle de la feuille de style, au lieu d'en exister une seconde ici.
 */
export function restoreSidebarWidth(): void {
  const stored = Number(localStorage.getItem(WIDTH_KEY))
  if (Number.isFinite(stored) && stored > 0) setSidebarWidth(stored, false)
}
