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
import { applyTypingIndicator, currentTypingIndicator, resolveTypingIndicator, subscribeTypingIndicator } from './typing-indicator'

/**
 * Theme, code palette, indicator, and appearance sliders stored on the account. `localStorage`
 * remains the pre-hydration cache read by `index.html` to prevent default-color flashes. The
 * account is authoritative: apply its copy when received and send every local change back.
 */

/** Sliders move continuously: write only after the gesture settles. */
const PUSH_DELAY_MS = 500

let timer: ReturnType<typeof setTimeout> | null = null
let inFlight = 0
// True while applying the server copy: do not send that back as a local change.
let adopting = false

function snapshot(): AppearancePrefs {
  return {
    theme: currentTheme(),
    syntax: currentSyntaxTheme(),
    typingIndicator: currentTypingIndicator(),
    values: { ...currentAppearance() },
  }
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
  // Do not update query cache: the reply adds nothing to the sent data and reapplying it could undo
  // a newer gesture.
  void api
    .patch('/api/me/settings', { appearance: snapshot() })
    .catch(() => {
      // Offline or expired session: local cache retains settings and the next change retries sending.
    })
    .finally(() => {
      inFlight -= 1
    })
}

function adopt(prefs: AppearancePrefs): void {
  adopting = true
  try {
    const typingIndicator = resolveTypingIndicator(prefs.typingIndicator)
    if (typingIndicator !== currentTypingIndicator()) applyTypingIndicator(typingIndicator)
    // Ignore names removed since saving rather than applying them unchanged.
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

    // Apply all known sliders, including defaults for omitted ones: a reset on another device must
    // reset this one too.
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

/** Mount once in the authenticated shell. */
export function useAppearanceSync(): void {
  const { data: settings } = useUserSettings()

  useEffect(() => {
    const unsubscribe = [
      subscribeTheme(schedulePush),
      subscribeSyntaxTheme(schedulePush),
      subscribeTypingIndicator(schedulePush),
      subscribeAppearance(schedulePush),
    ]
    return () => {
      for (const stop of unsubscribe) stop()
    }
  }, [])

  const appearance = settings?.appearance
  useEffect(() => {
    if (appearance === undefined) return
    // Never saved: adopt this browser's existing settings for the account instead of overwriting
    // them with defaults.
    if (appearance === null) {
      push()
      return
    }
    // A pending or in-flight send is newer than this copy.
    if (timer || inFlight > 0) return
    adopt(appearance)
  }, [appearance])
}
