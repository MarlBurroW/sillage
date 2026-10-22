import { useSyncExternalStore } from 'react'
import { languageFromPath } from './highlight'

/**
 * Editor Markdown display mode: preview or source. One preference rather than per-tab state: users
 * generally open Markdown to read or edit, an intent rarely changing between files. Remember and
 * persist it to avoid repeated switching. Outside React because the conversation header also
 * controls it: agent-instruction shortcuts open rendered files regardless of current mode.
 */

export type MarkdownView = 'preview' | 'source'

/** Extensions supporting preview. Exclude `mdx`, which is JSX rather than plain text. */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd'])

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(languageFromPath(path))
}

const KEY = 'sillage.markdownView'

// Default to preview: Markdown opened from the explorer is usually documentation intended for reading.
let view: MarkdownView = localStorage.getItem(KEY) === 'source' ? 'source' : 'preview'
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useMarkdownView(): MarkdownView {
  return useSyncExternalStore(
    subscribe,
    () => view,
    () => 'preview' as const,
  )
}

export function setMarkdownView(next: MarkdownView): void {
  if (next === view) return
  view = next
  localStorage.setItem(KEY, next)
  for (const listener of listeners) listener()
}
