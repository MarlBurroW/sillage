import { useSyncExternalStore } from 'react'
import type { MessageKey } from './i18n'

export const TYPING_INDICATORS = ['sillage', 'wave', 'orbit', 'ink', 'constellation', 'breath'] as const
export type TypingIndicatorStyle = (typeof TYPING_INDICATORS)[number]
export const DEFAULT_TYPING_INDICATOR: TypingIndicatorStyle = 'sillage'
export const TYPING_INDICATOR_LABELS: Record<TypingIndicatorStyle, MessageKey> = {
  sillage: 'typingIndicator.sillage',
  wave: 'typingIndicator.wave',
  orbit: 'typingIndicator.orbit',
  ink: 'typingIndicator.ink',
  constellation: 'typingIndicator.constellation',
  breath: 'typingIndicator.breath',
}

const STORAGE_KEY = 'sillage.typingIndicator'

/** Un style retiré ou un ancien compte retrouve le logo plutôt qu’un vide. */
export function resolveTypingIndicator(value: unknown): TypingIndicatorStyle {
  return TYPING_INDICATORS.includes(value as TypingIndicatorStyle)
    ? value as TypingIndicatorStyle
    : DEFAULT_TYPING_INDICATOR
}

let current = resolveTypingIndicator(localStorage.getItem(STORAGE_KEY))
const listeners = new Set<() => void>()

export function currentTypingIndicator(): TypingIndicatorStyle {
  return current
}

export function subscribeTypingIndicator(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function applyTypingIndicator(next: TypingIndicatorStyle): void {
  if (next === DEFAULT_TYPING_INDICATOR) localStorage.removeItem(STORAGE_KEY)
  else localStorage.setItem(STORAGE_KEY, next)
  current = next
  for (const listener of listeners) listener()
}

export function useTypingIndicator(): [TypingIndicatorStyle, (next: TypingIndicatorStyle) => void] {
  return [useSyncExternalStore(subscribeTypingIndicator, currentTypingIndicator), applyTypingIndicator]
}
