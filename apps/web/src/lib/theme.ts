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
