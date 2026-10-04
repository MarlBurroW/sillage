import { useEffect } from 'react'
import type { AppearancePrefs } from '@sillage/protocol'
import {
  APPEARANCE_SETTINGS,
  applyAppearance,
  currentAppearance,
  subscribeAppearance,
  type AppearanceKey,
} from './appearance'
import { api } from './api'
import { SYNTAX_THEMES, applySyntaxTheme, currentSyntaxTheme, subscribeSyntaxTheme, type SyntaxTheme } from './syntax-theme'
import { THEMES, applyTheme, currentTheme, subscribeTheme, type Theme } from './theme'
import { useUserSettings } from './user-settings'

/**
 * Thème, palette de code et curseurs d'apparence, enregistrés sur le compte.
 *
 * `localStorage` reste le cache lu par `index.html` avant l'hydratation, sans quoi
 * chaque chargement flasherait les couleurs par défaut. Le compte fait foi : sa copie
 * est appliquée dès qu'elle arrive, et chaque changement local y repart.
 */

/** Les curseurs glissent : on n'écrit qu'une fois le geste posé. */
const PUSH_DELAY_MS = 500

let timer: ReturnType<typeof setTimeout> | null = null
let inFlight = 0
// Vrai pendant qu'on applique la copie du serveur : ce n'est pas un changement à renvoyer.
let adopting = false

function snapshot(): AppearancePrefs {
  return { theme: currentTheme(), syntax: currentSyntaxTheme(), values: { ...currentAppearance() } }
}

function schedulePush(): void {
  if (adopting) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    push()
  }, PUSH_DELAY_MS)
}

function push(): void {
  inFlight += 1
  // Sans mise à jour du cache de requête : la réponse ne dit rien de plus que ce
  // qu'on vient d'envoyer, et la réappliquer pourrait défaire un geste plus récent.
  void api
    .patch('/api/me/settings', { appearance: snapshot() })
    .catch(() => {
      // Hors ligne ou session expirée : le cache local garde le réglage, et le
      // prochain changement retentera l'envoi.
    })
    .finally(() => {
      inFlight -= 1
    })
}

function adopt(prefs: AppearancePrefs): void {
  adopting = true
  try {
    // Un nom retiré depuis l'enregistrement est ignoré plutôt qu'appliqué tel quel.
    if (prefs.theme && THEMES.includes(prefs.theme as Theme) && prefs.theme !== currentTheme()) {
      applyTheme(prefs.theme as Theme)
    }
    if (
      prefs.syntax &&
      SYNTAX_THEMES.includes(prefs.syntax as SyntaxTheme) &&
      prefs.syntax !== currentSyntaxTheme()
    ) {
      applySyntaxTheme(prefs.syntax as SyntaxTheme)
    }

    // Tous les curseurs connus, défaut compris pour ceux absents de la copie : un
    // réglage remis à zéro sur un autre poste doit l'être ici aussi.
    const current = currentAppearance()
    const next: Partial<Record<AppearanceKey, number>> = {}
    for (const [name, setting] of Object.entries(APPEARANCE_SETTINGS) as [AppearanceKey, typeof APPEARANCE_SETTINGS[AppearanceKey]][]) {
      const stored = prefs.values[name]
      const value =
        typeof stored === 'number' ? Math.min(setting.max, Math.max(setting.min, stored)) : setting.fallback
      if (value !== current[name]) next[name] = value
    }
    if (Object.keys(next).length > 0) applyAppearance(next)
  } finally {
    adopting = false
  }
}

/** À monter une fois, dans la coquille authentifiée. */
export function useAppearanceSync(): void {
  const { data: settings } = useUserSettings()

  useEffect(() => {
    const unsubscribe = [
      subscribeTheme(schedulePush),
      subscribeSyntaxTheme(schedulePush),
      subscribeAppearance(schedulePush),
    ]
    return () => {
      for (const stop of unsubscribe) stop()
    }
  }, [])

  const appearance = settings?.appearance
  useEffect(() => {
    if (appearance === undefined) return
    // Jamais enregistré : ce navigateur a peut-être déjà des réglages, ils deviennent
    // ceux du compte au lieu d'être écrasés par les défauts.
    if (appearance === null) {
      push()
      return
    }
    // Un envoi en attente ou en route est plus récent que cette copie.
    if (timer || inFlight > 0) return
    adopt(appearance)
  }, [appearance])
}
