import { useSyncExternalStore } from 'react'

/**
 * Projets repliés dans la navigation latérale, retenus d'une visite à l'autre.
 *
 * Sans mémoire, un compte qui suit dix projets et n'en travaille qu'un devait les
 * replier à chaque rechargement : le repli ne servait qu'à la session en cours, donc
 * presque à rien. La préférence est locale au navigateur, comme la vue d'accueil
 * ([[project-view]]) et le repli de la sidebar : c'est une habitude de poste de
 * travail, pas une propriété du projet que les autres comptes auraient à subir.
 */

const KEY = 'sillage.projectsCollapsed'

function read(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === 'string'))
  } catch {
    // Une préférence d'affichage illisible ne vaut pas d'écran d'erreur : on repart
    // tout déplié, et le prochain repli réécrit une valeur saine.
    return new Set()
  }
}

let collapsed = read()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Instance figée : `useSyncExternalStore` compare les instantanés par identité. */
const EMPTY: ReadonlySet<string> = new Set()

export function useCollapsedProjects(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => collapsed,
    () => EMPTY,
  )
}

export function toggleProjectCollapsed(projectId: string): void {
  const next = new Set(collapsed)
  if (!next.delete(projectId)) next.add(projectId)
  collapsed = next
  localStorage.setItem(KEY, JSON.stringify([...next]))
  for (const listener of listeners) listener()
}
