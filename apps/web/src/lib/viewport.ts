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
 * Hauteur que le clavier doit prendre, au-delà de l'écart au repos, pour être reconnu.
 *
 * Assez bas pour ne manquer aucun clavier, et sans rapport avec l'écart constant que
 * certaines plateformes affichent hors saisie, lequel est mesuré séparément.
 */
const KEYBOARD_MIN_PX = 80

export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const root = document.documentElement

    /**
     * Écart entre les deux viewports hors clavier.
     *
     * Une PWA installée en rapporte un non nul et constant, sans qu'aucun clavier ne
     * soit ouvert. Il était traité par un seuil fixe, que l'écart réel d'un appareil
     * pouvait dépasser : la hauteur du viewport visuel s'imposait alors en permanence
     * et laissait une bande vide sous la barre de saisie, de la hauteur de cet écart.
     *
     * Le plus petit écart observé est celui d'un clavier fermé, donc il se mesure au
     * lieu de se deviner. Un minimum ne fait que décroître, ce qui le corrige tout
     * seul s'il a été relevé au mauvais moment.
     */
    let resting = Number.POSITIVE_INFINITY

    const clear = () => {
      root.style.removeProperty('--sg-app-height')
      root.style.removeProperty('--sg-viewport-top')
    }

    const apply = () => {
      const gap = window.innerHeight - viewport.height
      if (gap < resting) resting = gap

      // Le clavier est la seule raison d'imposer une hauteur : hors de ce cas, la
      // mesure est retirée plutôt que corrigée, et la règle CSS reprend la main.
      if (gap - resting < KEYBOARD_MIN_PX) {
        clear()
        return
      }

      root.style.setProperty('--sg-app-height', `${viewport.height}px`)
      // iOS fait aussi défiler la page derrière le clavier : sans compenser ce
      // décalage, l'en-tête sort par le haut de l'écran.
      root.style.setProperty('--sg-viewport-top', `${viewport.offsetTop}px`)
    }

    // Une rotation change l'écart au repos : la mesure repart de zéro, sans quoi
    // l'ancienne, plus petite, ferait passer le nouvel écart pour un clavier.
    const remeasure = () => {
      resting = Number.POSITIVE_INFINITY
      apply()
    }

    apply()
    viewport.addEventListener('resize', apply)
    viewport.addEventListener('scroll', apply)
    window.addEventListener('orientationchange', remeasure)

    return () => {
      viewport.removeEventListener('resize', apply)
      viewport.removeEventListener('scroll', apply)
      window.removeEventListener('orientationchange', remeasure)
      clear()
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
