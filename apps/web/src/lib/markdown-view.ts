import { useSyncExternalStore } from 'react'
import { languageFromPath } from './highlight'

/**
 * Mode d'affichage des fichiers markdown dans l'éditeur : rendu ou source.
 *
 * Une préférence unique et non un état par onglet : on ouvre un `.md` soit pour le lire,
 * soit pour le corriger, et cette intention change rarement d'un fichier à l'autre. La
 * retenir évite de rebasculer à chaque ouverture. Elle est persistée pour la même raison.
 *
 * Hors de React parce que l'en-tête de la conversation la pilote aussi : le raccourci vers
 * les consignes de l'agent ouvre son fichier en rendu, quel que soit le mode courant.
 */

export type MarkdownView = 'preview' | 'source'

/** Extensions dont le rendu est proposé. `mdx` en est exclu : c'est du JSX, pas du texte. */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd'])

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(languageFromPath(path))
}

const KEY = 'sillage.markdownView'

// Le rendu par défaut : un markdown ouvert depuis l'explorateur est presque toujours de la
// documentation, qu'on vient lire.
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
