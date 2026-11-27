import { useSyncExternalStore } from 'react'
import type { ToolItem } from './chat-fold'
import type { MessageKey } from './i18n'
import { toolActivity } from './tool-presentation'

export const TOOL_STYLES = ['inline', 'timeline', 'intent', 'cards', 'console', 'classic', 'sober'] as const
export type ToolStyle = (typeof TOOL_STYLES)[number]
export const DEFAULT_TOOL_STYLE: ToolStyle = 'inline'
export const TOOL_STYLE_LABELS: Record<ToolStyle, MessageKey> = {
  inline: 'toolStyle.inline', timeline: 'toolStyle.timeline', intent: 'toolStyle.intent',
  cards: 'toolStyle.cards', console: 'toolStyle.console', classic: 'toolStyle.classic',
  sober: 'toolStyle.sober',
}

/**
 * How one call row is drawn. Minimal is about what is shown, not how: it keeps each sequence on
 * one line, and a sequence the reader opens, like the calls kept apart, looks like the default.
 */
export function callLook(style: ToolStyle): ToolStyle {
  return style === 'sober' ? DEFAULT_TOOL_STYLE : style
}

const STORAGE_KEY = 'sillage.toolStyle'

/** Un ancien compte ou une valeur inconnue retrouve les lignes discrètes. */
export function resolveToolStyle(value: unknown): ToolStyle {
  return TOOL_STYLES.includes(value as ToolStyle)
    ? value as ToolStyle
    : DEFAULT_TOOL_STYLE
}

let current = resolveToolStyle(localStorage.getItem(STORAGE_KEY))
const listeners = new Set<() => void>()

export function currentToolStyle(): ToolStyle {
  return current
}

export function subscribeToolStyle(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function applyToolStyle(next: ToolStyle): void {
  if (next === DEFAULT_TOOL_STYLE) localStorage.removeItem(STORAGE_KEY)
  else localStorage.setItem(STORAGE_KEY, next)
  current = next
  for (const listener of listeners) listener()
}

export function useToolStyle(): [ToolStyle, (next: ToolStyle) => void] {
  return [useSyncExternalStore(subscribeToolStyle, currentToolStyle), applyToolStyle]
}

/**
 * How activity lines word a running call, for `describeActivity`: Minimal says what kind of work it
 * is, the other styles name the tool their rows show.
 */
export function useRunningToolLabel(): ((tool: ToolItem) => string) | undefined {
  const [style] = useToolStyle()
  return style === 'sober' ? toolActivity : undefined
}
