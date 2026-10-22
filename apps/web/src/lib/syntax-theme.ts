import type { MessageKey } from './i18n'
import { useSyncExternalStore } from 'react'

/**
 * Syntax palette independent of the UI theme. Overrides only seven `--sg-syn-*` tokens, leaving the
 * rest unchanged. Values live in `tokens.css` like other tokens; this module only sets their
 * selecting attribute. High-contrast theme always retains its own palette because an ambient
 * palette would defeat its purpose.
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
  // The default palette lives in `:root[data-theme=...]`: remove the attribute rather than
  // duplicate its values.
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
