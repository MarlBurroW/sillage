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

/**
 * Écart entre le bas du viewport et le bas de l'écran, publié dans `--sg-viewport-gap`.
 *
 * Une application installée sur iOS remonte le viewport de la hauteur de la barre
 * d'état et l'ancre en haut : 894 px de viewport pour un écran de 956, donc 62 px hors
 * d'atteinte en bas. L'indicateur d'accueil, lui, est dans ces 62 px : écarter le
 * contenu de `env(safe-area-inset-bottom)` par-dessus le paie une deuxième fois, et
 * c'est autant de hauteur perdue sur un téléphone.
 *
 * L'écart est donc mesuré et retranché de l'encoche. Réservé au mode installé : un
 * navigateur ordinaire montre le même écart quand ses barres d'outils sont dépliées, et
 * le contenu passerait dessous. La mesure suppose le portrait, ce que le manifeste
 * impose déjà.
 */
function publishViewportGap(root: HTMLElement): void {
  if (!matchMedia('(display-mode: standalone)').matches) return
  const gap = Math.max(0, screen.height - window.innerHeight)
  root.style.setProperty('--sg-viewport-gap', `${gap}px`)
}

export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const root = document.documentElement
    publishViewportGap(root)

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
      /*
       * Le clavier refermé peut laisser le viewport visuel décalé dans le viewport de
       * mise en page : iPadOS en mode installé ne le ramène pas toujours à zéro, et
       * n'émet alors ni `resize` ni `scroll`. Le calque fixe est bien redessiné à sa
       * place, mais WebKit garde les zones de toucher de l'ancien décalage jusqu'au
       * prochain défilement : la barre de saisie et le bas du fil ne répondent plus
       * au doigt. Remettre le document à zéro recale les deux viewports et force ce
       * recalcul. Sans décalage, l'appel ne fait rien.
       */
      window.scrollTo(0, 0)
    }

    const hasInputFocus = () => document.activeElement instanceof HTMLElement
      && document.activeElement.matches('input, textarea, [contenteditable]:not([contenteditable="false"])')

    const apply = () => {
      // `innerHeight` peut suivre le clavier sur iOS ; le calque fixe reste, lui,
      // dimensionné par le viewport de mise en page.
      const gap = Math.max(0, Math.max(root.clientHeight, window.innerHeight) - viewport.height)
      // Un montage ou une rotation pendant la saisie ne doit pas enregistrer la
      // hauteur du clavier comme écart au repos. La fermeture affinera la mesure.
      if (!hasInputFocus() && gap < resting) resting = gap
      const baseline = Number.isFinite(resting) ? resting : 0

      // Le clavier est la seule raison d'imposer une hauteur : hors de ce cas, la
      // mesure est retirée plutôt que corrigée, et la règle CSS reprend la main.
      if (gap - baseline < KEYBOARD_MIN_PX) {
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
      publishViewportGap(root)
      apply()
    }

    /*
     * Filet pour le clavier qui se ferme sans événement de viewport (voir `clear`) :
     * quand la saisie perd le focus et qu'aucune autre ne le reprend, la mesure est
     * rejouée après le délai de l'animation du clavier. Si `resize` a bien été émis
     * entre-temps, `apply` a déjà tout remis et ce passage ne change rien.
     */
    let settle: ReturnType<typeof setTimeout> | undefined
    const onFocusOut = () => {
      clearTimeout(settle)
      settle = setTimeout(() => {
        if (hasInputFocus()) return
        apply()
        // `apply` ne touche à rien si le clavier n'était pas reconnu : le recalage du
        // document doit quand même avoir lieu.
        window.scrollTo(0, 0)
      }, 350)
    }

    apply()
    viewport.addEventListener('resize', apply)
    viewport.addEventListener('scroll', apply)
    window.addEventListener('orientationchange', remeasure)
    document.addEventListener('focusout', onFocusOut)

    return () => {
      clearTimeout(settle)
      viewport.removeEventListener('resize', apply)
      viewport.removeEventListener('scroll', apply)
      window.removeEventListener('orientationchange', remeasure)
      document.removeEventListener('focusout', onFocusOut)
      root.style.removeProperty('--sg-viewport-gap')
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
