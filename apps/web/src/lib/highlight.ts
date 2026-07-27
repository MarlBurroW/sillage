/**
 * Coloration syntaxique, partagée par les blocs de code du markdown et par les
 * payloads des appels d'outils.
 *
 * Aucune détection automatique de langage : sur les extraits courts elle se trompe
 * souvent, et un bloc mal coloré se lit plus mal qu'un bloc sans couleur. Sans langage
 * annoncé, avec un langage inconnu, ou avant que la bibliothèque soit chargée, le code
 * est rendu tel quel.
 */

import { useEffect, useState } from 'react'

type Highlighter = Awaited<typeof import('highlight.js/lib/common')>['default']

let highlighter: Highlighter | null = null
let loading: Promise<void> | null = null

/**
 * Au-delà, on ne colore plus. Un `Read` sur un gros fichier produit des centaines de
 * kilo-octets, et les colorer bloquerait le fil d'exécution le temps de l'analyse.
 */
const MAX_HIGHLIGHT_BYTES = 100_000

export function isHighlighterReady(): boolean {
  return highlighter !== null
}

/**
 * Charge la coloration et re-rend une fois qu'elle est là.
 *
 * Pour les vues qui colorent beaucoup de fragments courts, comme les lignes d'un diff,
 * où monter un composant complet par fragment coûterait plus cher que la coloration.
 */
export function useHighlighterReady(): boolean {
  const [ready, setReady] = useState(isHighlighterReady)

  useEffect(() => {
    if (ready) return

    let cancelled = false
    void loadHighlighter().then(() => {
      if (!cancelled) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [ready])

  return ready
}

/**
 * Langage déduit de l'extension du chemin.
 *
 * Ce n'est pas de la détection : l'extension est une donnée du fichier, pas une
 * supposition tirée de son contenu. highlight.js résout les extensions comme alias
 * (`ts`, `py`, `rs`, `yml`...), il n'y a donc aucune table à tenir à jour.
 */
export function languageFromPath(path: string): string {
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  // Un point situé avant le dernier séparateur appartient à un dossier, pas au fichier.
  if (dot <= slash + 1) return ''
  return path.slice(dot + 1).toLowerCase()
}

/**
 * Charge la coloration à la demande.
 *
 * La bibliothèque et ses grammaires pèsent une bonne part du bundle : la garder hors du
 * chargement initial évite de la payer sur l'écran de connexion ou sur une conversation
 * sans le moindre bloc de code.
 */
export function loadHighlighter(): Promise<void> {
  if (highlighter) return Promise.resolve()
  loading ??= import('highlight.js/lib/common').then((module) => {
    highlighter = module.default
  })
  return loading
}

/**
 * `html` n'a de sens que si `applied` vaut vrai. Sinon l'appelant rend la chaîne
 * d'origine comme texte, ce qui laisse React l'échapper au lieu de le faire à la main.
 */
export function highlight(code: string, language: string): { html: string; applied: boolean } {
  if (!language || code.length > MAX_HIGHLIGHT_BYTES || !highlighter?.getLanguage(language)) {
    return { html: '', applied: false }
  }
  return {
    html: highlighter.highlight(code, { language, ignoreIllegals: true }).value,
    applied: true,
  }
}
