import { useCallback, useSyncExternalStore } from 'react'

/**
 * Palette de coloration syntaxique, indépendante du thème de l'interface.
 *
 * Elle ne redéfinit que les sept jetons `--sg-syn-*` : le reste de l'interface ne
 * bouge pas. Les valeurs vivent dans `tokens.css`, comme tous les autres jetons ;
 * ce module ne fait que poser l'attribut qui les sélectionne.
 *
 * Le thème contrasté garde sa propre palette quoi qu'il arrive : son contraste est sa
 * raison d'être, et une palette d'ambiance l'annulerait.
 */

export const SYNTAX_THEMES = [
  'sillage',
  'ocean',
  'nuit',
  'agrume',
  'cerise',
  'foret',
  'sable',
  'ardoise',
  'sobre',
  'encre',
] as const
export type SyntaxTheme = (typeof SYNTAX_THEMES)[number]

export const SYNTAX_THEME_LABELS: Record<SyntaxTheme, string> = {
  sillage: 'Sillage',
  ocean: 'Océan',
  nuit: 'Nuit',
  agrume: 'Agrume',
  cerise: 'Cerise',
  foret: 'Forêt',
  sable: 'Sable',
  ardoise: 'Ardoise',
  sobre: 'Sobre',
  encre: 'Encre',
}

const STORAGE_KEY = 'sillage.syntax'
const listeners = new Set<() => void>()

function current(): SyntaxTheme {
  const value = document.documentElement.dataset.syntax
  return SYNTAX_THEMES.includes(value as SyntaxTheme) ? (value as SyntaxTheme) : 'sillage'
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSyntaxTheme(): [SyntaxTheme, (theme: SyntaxTheme) => void] {
  const theme = useSyncExternalStore(subscribe, current, () => 'sillage' as SyntaxTheme)

  const setTheme = useCallback((next: SyntaxTheme) => {
    // La palette par défaut est celle qui vit dans `:root[data-theme=...]` : elle
    // s'obtient en retirant l'attribut, pas en dupliquant ses valeurs.
    if (next === 'sillage') delete document.documentElement.dataset.syntax
    else document.documentElement.dataset.syntax = next

    localStorage.setItem(STORAGE_KEY, next)
    for (const listener of listeners) listener()
  }, [])

  return [theme, setTheme]
}
