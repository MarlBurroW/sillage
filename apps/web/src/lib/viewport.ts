import { useCallback, useEffect, useSyncExternalStore } from 'react'

/**
 * Hauteur réellement visible, publiée dans `--sg-app-height`.
 *
 * Sur mobile, l'ouverture du clavier réduit le viewport visuel sans toucher au
 * viewport de mise en page : `100dvh` continue de valoir la hauteur de l'écran entier
 * et la barre de saisie se retrouve cachée sous le clavier. `visualViewport` est la
 * seule mesure qui suive le clavier.
 *
 * La valeur est écrite en variable CSS plutôt que remontée en état React : le clavier
 * émet des dizaines d'événements pendant son animation, et re-rendre l'application à
 * chacun ferait ramer le fil de conversation.
 */
/**
 * En deçà, l'écart entre les deux viewports ne vient pas du clavier.
 *
 * Une PWA installée rapporte un viewport visuel plus court que l'écran sans qu'aucun
 * clavier ne soit ouvert : imposer cette hauteur laissait une bande vide en bas de
 * l'application, sous la barre de saisie. Tant qu'on reste sous ce seuil, `100dvh`
 * fait foi et le calque remplit l'écran.
 */
const KEYBOARD_MIN_PX = 120

export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const root = document.documentElement
    const apply = () => {
      // Le clavier est la seule raison d'imposer une hauteur : hors de ce cas, la
      // mesure est retirée plutôt que corrigée, et la règle CSS reprend la main.
      if (window.innerHeight - viewport.height < KEYBOARD_MIN_PX) {
        root.style.removeProperty('--sg-app-height')
        root.style.removeProperty('--sg-viewport-top')
        return
      }

      root.style.setProperty('--sg-app-height', `${viewport.height}px`)
      // iOS fait aussi défiler la page derrière le clavier : sans compenser ce
      // décalage, l'en-tête sort par le haut de l'écran.
      root.style.setProperty('--sg-viewport-top', `${viewport.offsetTop}px`)
    }

    apply()
    viewport.addEventListener('resize', apply)
    viewport.addEventListener('scroll', apply)

    return () => {
      viewport.removeEventListener('resize', apply)
      viewport.removeEventListener('scroll', apply)
      root.style.removeProperty('--sg-app-height')
      root.style.removeProperty('--sg-viewport-top')
    }
  }, [])
}

/**
 * Suit une requête média.
 *
 * Nécessaire là où une classe `hidden` ne suffit pas : un élément caché en CSS est
 * quand même monté, et une redirection montée est une redirection exécutée. La liste
 * de réglages en dépend, elle est la page entière au doigt et une colonne ailleurs.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    // Rendu serveur absent ici, mais `useSyncExternalStore` réclame l'instantané.
    () => false,
  )
}
