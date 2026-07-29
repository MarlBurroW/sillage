import type { MessageKey } from './i18n'
import { useCallback, useSyncExternalStore } from 'react'

export const THEMES = ['light', 'dark', 'dark-contrast'] as const
export type Theme = (typeof THEMES)[number]

export const THEME_LABELS: Record<Theme, MessageKey> = {
  light: 'theme.light',
  dark: 'theme.dark',
  'dark-contrast': 'theme.darkContrast',
}

const STORAGE_KEY = 'sillage.theme'
const listeners = new Set<() => void>()

/**
 * Recopie le canevas résolu dans `theme-color`.
 *
 * iOS peint avec cette couleur les bandes hors viewport d'une application installée,
 * celle de la barre d'état et celle de l'indicateur d'accueil. Écrite en dur dans le
 * document, elle restait au bleu sombre du thème par défaut et jurait sous un thème
 * clair. Le thème et les réglages d'apparence écrivent tous les deux sur `<html>`, un
 * observateur les couvre donc sans qu'aucun des deux ait à connaître cette balise.
 *
 * La balise est remplacée plutôt que réécrite : iOS ne relit pas un `content` modifié en
 * place, et la bande du haut gardait la couleur du lancement jusqu'à ce qu'on referme
 * l'application. L'observateur ne surveille que `<html>`, ce remplacement ne le relance
 * donc pas.
 */
export function watchThemeColor(): void {
  const initial = document.querySelector('meta[name="theme-color"]')
  if (!(initial instanceof HTMLMetaElement)) return
  let meta: HTMLMetaElement = initial

  const sync = () => {
    const canvas = getComputedStyle(document.documentElement).getPropertyValue('--sg-canvas').trim()
    // Les curseurs d'apparence tirent une rafale de mutations : on ne remplace la balise
    // que quand la couleur a réellement bougé.
    if (!canvas || canvas === meta.content) return

    const next = document.createElement('meta')
    next.name = 'theme-color'
    next.content = canvas
    meta.replaceWith(next)
    meta = next
  }

  sync()
  new MutationObserver(sync).observe(document.documentElement, {
    attributeFilter: ['data-theme', 'style'],
  })
}

function currentTheme(): Theme {
  const value = document.documentElement.dataset.theme
  return THEMES.includes(value as Theme) ? (value as Theme) : 'dark'
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => 'dark' as Theme)

  const setTheme = useCallback((next: Theme) => {
    document.documentElement.dataset.theme = next
    localStorage.setItem(STORAGE_KEY, next)
    for (const listener of listeners) listener()
  }, [])

  return [theme, setTheme]
}
