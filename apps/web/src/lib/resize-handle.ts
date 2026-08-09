import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'

/**
 * Poignée de largeur, partagée par la sidebar, le panneau latéral, le tiroir de carte
 * et la colonne de l'explorateur.
 *
 * Ces quatre-là ne diffèrent que par la façon dont l'abscisse du pointeur devient une
 * largeur : la sidebar part du bord gauche de la fenêtre, le panneau et le tiroir du
 * bord droit, la colonne de l'explorateur du bord gauche de son conteneur. Tout le
 * reste, l'écoute posée sur la fenêtre plutôt que sur la poignée, le curseur et la
 * sélection neutralisés le temps du geste, l'enregistrement au seul relâchement, était
 * recopié à l'identique.
 */

/** Pas du réglage au clavier : assez fin pour ajuster, assez gros pour arriver. */
const KEY_STEP_PX = 16

export interface ResizeHandle {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
}

export function resizeHandle({
  widthAt,
  current,
  apply,
}: {
  /** Largeur voulue quand le pointeur est à cette abscisse. */
  widthAt: (clientX: number) => number
  /** Largeur actuelle, que le clavier ajuste faute de pointeur. `null` si illisible. */
  current: () => number | null
  /**
   * `persist` est faux pendant le glissement : un geste émet un événement par image, et
   * écrire dans `localStorage` à chacune rendrait la poignée pâteuse.
   */
  apply: (width: number, persist: boolean) => void
}): ResizeHandle {
  return {
    onPointerDown: (event) => {
      event.preventDefault()

      const move = (moved: PointerEvent) => apply(widthAt(moved.clientX), false)
      const stop = (released: PointerEvent) => {
        apply(widthAt(released.clientX), true)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', stop)
        document.body.style.removeProperty('cursor')
        document.body.style.removeProperty('user-select')
      }

      // Sur la fenêtre et non sur la poignée : le pointeur la quitte dès la première
      // image d'un glissement rapide, et le geste doit continuer de suivre.
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', stop)
      // Sans ça, le glissement sélectionne le texte au passage et le curseur redevient
      // une flèche dès qu'on quitte la poignée.
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },

    onKeyDown: (event) => {
      const arrow = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
      if (arrow === 0) return

      const width = current()
      if (width === null) return

      event.preventDefault()
      // Le sens vient de `widthAt` : une poignée posée sur un bord droit élargit vers la
      // droite, une poignée posée sur un bord gauche vers la gauche. Le déduire évite
      // d'avoir à le redire à chaque appel, et d'oublier de l'inverser.
      const step = widthAt(1) > widthAt(0) ? arrow * KEY_STEP_PX : -arrow * KEY_STEP_PX
      apply(width + step, true)
    },
  }
}
