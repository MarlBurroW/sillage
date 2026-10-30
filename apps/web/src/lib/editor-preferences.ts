import { useSyncExternalStore } from 'react'
import { languageFromPath } from './highlight'

/**
 * Editor display preferences. One value each rather than per-tab state: users open Markdown to
 * read or to edit, wrap long lines or not, an intent rarely changing between files. Remembered
 * and persisted to avoid switching again at every file. Outside React because other places set
 * them: agent-instruction shortcuts open rendered files regardless of the current mode.
 */

/** A file shown rendered (Markdown, SVG) or as its source text. */
export type DocumentView = 'preview' | 'source'

/** Extensions supporting preview. Exclude `mdx`, which is JSX rather than plain text. */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd'])

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(languageFromPath(path))
}

export function isSvgPath(path: string): boolean {
  return languageFromPath(path) === 'svg'
}

function preference<T extends string>(key: string, values: readonly T[], fallback: T) {
  const stored = localStorage.getItem(key)
  let value: T = values.find((candidate) => candidate === stored) ?? fallback
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return {
    use: (): T => useSyncExternalStore(subscribe, () => value, () => fallback),
    set: (next: T): void => {
      if (next === value) return
      value = next
      localStorage.setItem(key, next)
      for (const listener of listeners) listener()
    },
  }
}

// Default to preview: Markdown opened from the explorer is usually documentation intended for reading.
const markdown = preference<DocumentView>('sillage.markdownView', ['preview', 'source'], 'preview')
export const useMarkdownView = markdown.use
export const setMarkdownView = markdown.set

// An SVG is first an image; its source is a toggle away.
const svg = preference<DocumentView>('sillage.svgView', ['preview', 'source'], 'preview')
export const useSvgView = svg.use
export const setSvgView = svg.set

// Wrapped by default, as before the toggle: panels are narrow and horizontal scrolling hides code.
const wrap = preference<'on' | 'off'>('sillage.editorWrap', ['on', 'off'], 'on')
export const useEditorWrap = (): boolean => wrap.use() === 'on'
export const setEditorWrap = (on: boolean): void => wrap.set(on ? 'on' : 'off')
