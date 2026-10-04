import type { MessageKey } from './i18n'
import { useSyncExternalStore } from 'react'

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

export const SYNTAX_THEME_LABELS: Record<SyntaxTheme, MessageKey> = {
  sillage: 'syntax.theme.sillage',
  ocean: 'syntax.theme.ocean',
  nuit: 'syntax.theme.nuit',
  agrume: 'syntax.theme.agrume',
  cerise: 'syntax.theme.cerise',
  foret: 'syntax.theme.forest',
  sable: 'syntax.theme.sable',
  ardoise: 'syntax.theme.ardoise',
  sobre: 'syntax.theme.sobre',
  encre: 'syntax.theme.encre',
}

const STORAGE_KEY = 'sillage.syntax'
const listeners = new Set<() => void>()

export function currentSyntaxTheme(): SyntaxTheme {
  const value = document.documentElement.dataset.syntax
  return SYNTAX_THEMES.includes(value as SyntaxTheme) ? (value as SyntaxTheme) : 'sillage'
}

export function subscribeSyntaxTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function applySyntaxTheme(next: SyntaxTheme): void {
  // La palette par défaut est celle qui vit dans `:root[data-theme=...]` : elle
  // s'obtient en retirant l'attribut, pas en dupliquant ses valeurs.
  if (next === 'sillage') delete document.documentElement.dataset.syntax
  else document.documentElement.dataset.syntax = next

  localStorage.setItem(STORAGE_KEY, next)
  for (const listener of listeners) listener()
}

export function useSyntaxTheme(): [SyntaxTheme, (theme: SyntaxTheme) => void] {
  const theme = useSyncExternalStore(
    subscribeSyntaxTheme,
    currentSyntaxTheme,
    () => 'sillage' as SyntaxTheme,
  )
  return [theme, applySyntaxTheme]
}
