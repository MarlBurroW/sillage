import { useSyncExternalStore } from 'react'

/**
 * Onglets ouverts dans l'éditeur, par conversation.
 *
 * Hors de React parce que l'explorateur ouvre un onglet que l'éditeur affiche, et que
 * les deux sont dans des onglets de panneau distincts : passer par le parent ferait
 * remonter l'état à chaque frappe dans l'arborescence.
 *
 * Volontairement non persisté : un onglet renvoie à un fichier qui peut avoir disparu
 * entre deux sessions, et rouvrir une liste d'erreurs au démarrage vaut moins que de
 * repartir vide.
 */

interface Tabs {
  paths: string[]
  active: string | null
}

const EMPTY: Tabs = { paths: [], active: null }

const byConversation = new Map<string, Tabs>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useEditorTabs(conversationId: string): Tabs {
  return useSyncExternalStore(
    subscribe,
    () => byConversation.get(conversationId) ?? EMPTY,
    () => EMPTY,
  )
}

export function openTab(conversationId: string, path: string): void {
  const current = byConversation.get(conversationId) ?? EMPTY
  byConversation.set(conversationId, {
    // Un fichier déjà ouvert est activé, pas dupliqué.
    paths: current.paths.includes(path) ? current.paths : [...current.paths, path],
    active: path,
  })
  emit()
}

export function activateTab(conversationId: string, path: string): void {
  const current = byConversation.get(conversationId) ?? EMPTY
  if (current.active === path) return
  byConversation.set(conversationId, { ...current, active: path })
  emit()
}

/**
 * Déplace un onglet à une position donnée.
 *
 * L'ordre est celui d'ouverture par défaut, ce qui ne dit rien de l'usage : on
 * regroupe volontiers ce qui va ensemble.
 */
export function reorderTabs(conversationId: string, from: string, toIndex: number): void {
  const current = byConversation.get(conversationId) ?? EMPTY
  const fromIndex = current.paths.indexOf(from)
  if (fromIndex === -1 || fromIndex === toIndex) return

  const paths = current.paths.filter((entry) => entry !== from)
  paths.splice(Math.max(0, Math.min(toIndex, paths.length)), 0, from)
  byConversation.set(conversationId, { ...current, paths })
  emit()
}

/** Ferme tout sauf le chemin donné, ou tout si aucun n'est donné. */
export function closeOtherTabs(conversationId: string, keep: string | null): void {
  const paths = keep === null ? [] : [keep]
  byConversation.set(conversationId, { paths, active: keep })
  emit()
}

export function closeTab(conversationId: string, path: string): void {
  const current = byConversation.get(conversationId) ?? EMPTY
  const index = current.paths.indexOf(path)
  if (index === -1) return

  const paths = current.paths.filter((entry) => entry !== path)
  byConversation.set(conversationId, {
    paths,
    // Fermer l'onglet actif passe au voisin de droite, puis de gauche : c'est ce que
    // fait un navigateur, et revenir au premier onglet perdrait le fil de la lecture.
    active:
      current.active === path ? (paths[index] ?? paths[index - 1] ?? null) : current.active,
  })
  emit()
}
