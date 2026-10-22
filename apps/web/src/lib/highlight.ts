/**
 * Syntax highlighting shared by Markdown code blocks and tool payloads. Never autodetect languages:
 * short snippets are often misidentified and incorrect highlighting is harder to read than none.
 * With no language, an unknown language, or before the library loads, render code unchanged.
 */

import { useEffect, useState } from 'react'

type Highlighter = Awaited<typeof import('highlight.js/lib/common')>['default']

let highlighter: Highlighter | null = null
let loading: Promise<void> | null = null

/**
 * Skip highlighting above this size. Reading a large file can return hundreds of kilobytes; parsing
 * it would block the UI thread.
 */
const MAX_HIGHLIGHT_BYTES = 100_000

export function isHighlighterReady(): boolean {
  return highlighter !== null
}

/**
 * Load highlighting and rerender when ready. For views with many short fragments, such as diff
 * lines, mounting a component per fragment would cost more than highlighting itself.
 */
export function useHighlighterReady(): boolean {
  const [ready, setReady] = useState(isHighlighterReady)

  useEffect(() => {
    if (ready) return

    let cancelled = false
    void loadHighlighter().then(() => {
      if (!cancelled) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [ready])

  return ready
}

/**
 * Language from path extension. This is file metadata, not content-based guessing. highlight.js
 * resolves extensions as aliases (`ts`, `py`, `rs`, `yml`, etc.), requiring no maintained table.
 */
export function languageFromPath(path: string): string {
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  // A dot before the final separator belongs to a directory, not the file.
  if (dot <= slash + 1) return ''
  return path.slice(dot + 1).toLowerCase()
}

/**
 * Load highlighting on demand. The library and grammars form a large bundle share: excluding them
 * from initial load avoids paying for login screens or conversations without code blocks.
 */
export function loadHighlighter(): Promise<void> {
  if (highlighter) return Promise.resolve()
  loading ??= import('highlight.js/lib/common').then((module) => {
    highlighter = module.default
  })
  return loading
}

/**
 * `html` is meaningful only when `applied` is true. Otherwise callers render the original string as
 * text, letting React escape it rather than doing so manually.
 */
export function highlight(code: string, language: string): { html: string; applied: boolean } {
  if (!language || code.length > MAX_HIGHLIGHT_BYTES || !highlighter?.getLanguage(language)) {
    return { html: '', applied: false }
  }
  return {
    html: highlighter.highlight(code, { language, ignoreIllegals: true }).value,
    applied: true,
  }
}
