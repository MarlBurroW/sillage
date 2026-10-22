import type { MessageKey } from './i18n'
import { useSyncExternalStore } from 'react'

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
 * Copy the resolved canvas color into `theme-color`. Installed iOS apps use it for status-bar and
 * home-indicator strips outside the viewport. A hardcoded value retained the default dark blue and
 * clashed with light themes. Both theme and appearance write `<html>`, so one observer covers both
 * without either knowing this tag. Replace the tag rather than changing content: iOS ignores
 * in-place updates and kept the launch color until app closure. Since only `<html>` is observed,
 * replacement does not retrigger it.
 */
export function watchThemeColor(): void {
  const initial = document.querySelector('meta[name="theme-color"]')
  if (!(initial instanceof HTMLMetaElement)) return
  let meta: HTMLMetaElement = initial

  const sync = () => {
    const canvas = getComputedStyle(document.documentElement).getPropertyValue('--sg-canvas').trim()
    // Appearance sliders emit bursts of mutations: replace the tag only when the color actually changes.
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

export function currentTheme(): Theme {
  const value = document.documentElement.dataset.theme
  return THEMES.includes(value as Theme) ? (value as Theme) : 'dark'
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function applyTheme(next: Theme): void {
  document.documentElement.dataset.theme = next
  localStorage.setItem(STORAGE_KEY, next)
  for (const listener of listeners) listener()
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => 'dark' as Theme)
  return [theme, applyTheme]
}
