import { useEffect, useState, useSyncExternalStore } from 'react'

/**
 * État du panneau latéral droit, partagé hors de React.
 *
 * Même forme que `sidebar.ts`, et pour la même raison : l'en-tête de la conversation
 * porte le bouton d'ouverture, le panneau vit à côté du fil, et faire descendre
 * l'information par les props traverserait la vue entière pour un booléen.
 */

const OPEN_KEY = 'sillage.panelOpen'
const WIDTH_KEY = 'sillage.panelWidth'

/** En deçà, un chemin de fichier ne tient plus ; au-delà, le fil devient illisible. */
const MIN_WIDTH = 240
const MAX_WIDTH = 720

let open = localStorage.getItem(OPEN_KEY) === '1'
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePanelOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  )
}

/**
 * Durée de la transition d'ouverture, à tenir en accord avec la classe du panneau.
 *
 * Elle sert aussi à retarder le démontage : sans ce délai, fermer retirerait le
 * panneau du document avant que l'animation ait pu se jouer.
 */
export const PANEL_TRANSITION_MS = 200

/**
 * Présence du panneau dans le document, distincte de son état ouvert.
 *
 * Le panneau reste monté le temps de sortir de l'écran, puis disparaît : il tient des
 * terminaux vivants et des requêtes d'arborescence, qu'on ne veut pas garder derrière
 * un panneau fermé.
 */
export function usePanelPresence(): { mounted: boolean; open: boolean } {
  const open = usePanelOpen()
  const [mounted, setMounted] = useState(open)

  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }

    const timer = setTimeout(() => setMounted(false), PANEL_TRANSITION_MS)
    return () => clearTimeout(timer)
  }, [open])

  return { mounted, open }
}

export function setPanelOpen(next: boolean): void {
  if (next === open) return
  open = next
  localStorage.setItem(OPEN_KEY, next ? '1' : '0')
  for (const listener of listeners) listener()
}

/**
 * Largeur du panneau, publiée en variable CSS.
 *
 * Comme pour la sidebar : un glissement émet un événement par image, et re-rendre
 * l'arborescence à chacun rendrait la poignée pâteuse. `localStorage` n'est écrit
 * qu'au relâchement.
 */
export function setPanelWidth(px: number, persist: boolean): number {
  const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px)))
  document.documentElement.style.setProperty('--panel-width', `${width}px`)
  if (persist) localStorage.setItem(WIDTH_KEY, String(width))
  return width
}

export function restorePanelWidth(): void {
  const stored = Number(localStorage.getItem(WIDTH_KEY))
  if (Number.isFinite(stored) && stored > 0) setPanelWidth(stored, false)
}
