import { useSyncExternalStore } from 'react'

/**
 * Fine theme settings applied to `<html>` for the entire app. `hue` is shared with the accent;
 * `tint` scales surface chroma without changing accents; `lift` shifts surface lightness without
 * changing text.
 */

export interface AppearanceSetting {
  key: string
  property: string
  fallback: number
  min: number
  max: number
  step: number
}

export const APPEARANCE_SETTINGS = {
  // Defaults match tokens.css: hue 318 and subdued ambience (0.25).
  hue: { key: 'sillage.hue', property: '--sg-hue', fallback: 318, min: 0, max: 360, step: 1 },
  tint: { key: 'sillage.tint', property: '--sg-tint', fallback: 0.25, min: 0, max: 2.5, step: 0.05 },
  // Deliberately narrow bounds: beyond them surfaces approach text colors and contrast collapses
  // instead of simply getting lighter.
  lift: { key: 'sillage.lift', property: '--sg-lift', fallback: 0, min: -0.06, max: 0.12, step: 0.005 },

  /*
   * Thread reading comfort. These three settings affect message text only: enlarging conversations
   * must not move the sidebar. `readingSoftness` blends ink toward its muted shade rather than
   * reducing opacity, which would let backgrounds show through and change rendering. Cap at 0.6:
   * beyond it text becomes unreadable rather than soft.
   */
  // One shared limit keeps the thread, draft, and composer aligned.
  conversationWidth: {
    key: 'sillage.conversationWidth',
    property: '--sg-conversation-width',
    fallback: 768,
    min: 768,
    max: 1600,
    step: 32,
  },
  readingSize: {
    key: 'sillage.readingSize',
    property: '--sg-read-size',
    fallback: 0.9375,
    min: 0.8125,
    max: 1.25,
    step: 0.0625,
  },
  readingLeading: {
    key: 'sillage.readingLeading',
    property: '--sg-read-leading',
    fallback: 1.65,
    min: 1.4,
    max: 2.1,
    step: 0.05,
  },
  readingSoftness: {
    key: 'sillage.readingSoftness',
    property: '--sg-read-softness',
    fallback: 0,
    min: 0,
    max: 0.6,
    step: 0.05,
  },

  /*
   * Visual separation between a question and the following answer. Controls accent tint on the user
   * bubble: zero restores the original neutral surface, maximum produces a colored block. Alignment
   * and width already distinguish roles and do not change.
   */
  messageContrast: {
    key: 'sillage.messageContrast',
    property: '--sg-message-contrast',
    fallback: 0.45,
    min: 0,
    max: 1,
    step: 0.05,
  },
} satisfies Record<string, AppearanceSetting>

export type AppearanceKey = keyof typeof APPEARANCE_SETTINGS

function read({ key, fallback }: AppearanceSetting): number {
  const raw = localStorage.getItem(key)
  if (raw === null) return fallback
  const parsed = Number(raw)
  // `lift` accepts zero and negative values: check only finiteness.
  return Number.isFinite(parsed) ? parsed : fallback
}

/*
 * Outside React: account synchronization rewrites these values at load and all displaying screens
 * must follow without remounting.
 */
let values = Object.fromEntries(
  Object.entries(APPEARANCE_SETTINGS).map(([name, setting]) => [name, read(setting)]),
) as Record<AppearanceKey, number>
const listeners = new Set<() => void>()

export function currentAppearance(): Record<AppearanceKey, number> {
  return values
}

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Apply values and remove those returning to defaults: untouched settings should leave nothing in
 * `localStorage` or on `<html>`.
 */
export function applyAppearance(next: Partial<Record<AppearanceKey, number>>): void {
  const root = document.documentElement
  const merged = { ...values }
  for (const [name, value] of Object.entries(next) as [AppearanceKey, number][]) {
    const setting = APPEARANCE_SETTINGS[name]
    merged[name] = value
    if (value === setting.fallback) {
      root.style.removeProperty(setting.property)
      localStorage.removeItem(setting.key)
    } else {
      root.style.setProperty(setting.property, String(value))
      localStorage.setItem(setting.key, String(value))
    }
  }
  values = merged
  for (const listener of listeners) listener()
}

const setAppearance = (name: AppearanceKey, value: number) => applyAppearance({ [name]: value })

/**
 * Reset only currently visible settings: the button below typography sliders must not remove an
 * accent chosen elsewhere.
 */
function resetAppearance(names?: AppearanceKey[]): void {
  const targets = names ?? (Object.keys(APPEARANCE_SETTINGS) as AppearanceKey[])
  applyAppearance(Object.fromEntries(targets.map((name) => [name, APPEARANCE_SETTINGS[name].fallback])))
}

export function useAppearance() {
  const current = useSyncExternalStore(subscribeAppearance, currentAppearance)
  return { values: current, set: setAppearance, reset: resetAppearance }
}

/** Resolved token color for displaying actual values. */
export function resolveToken(token: string): string {
  const probe = document.createElement('span')
  probe.style.color = `var(${token})`
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const value = getComputedStyle(probe).color
  probe.remove()
  return value
}
