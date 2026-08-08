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
  /**
   * Onglet d'aperçu, celui qu'un clic simple vient d'ouvrir.
   *
   * Il n'y en a qu'un, et le prochain clic simple le remplace au lieu de s'ajouter :
   * sans lui, parcourir dix fichiers de l'arborescence laisse dix onglets derrière soi.
   * Il devient un onglet ordinaire dès qu'on montre qu'on le garde, en le double
   * cliquant ou en y écrivant.
   */
  preview: string | null
}

const EMPTY: Tabs = { paths: [], active: null, preview: null }

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

/**
 * Ouvre un fichier, ou l'active s'il est déjà là.
 *
 * `preview` désigne une ouverture de parcours, celle du clic simple dans
 * l'arborescence. Une ouverture demandée explicitement, elle, garde sa place.
 */
export function openTab(
  conversationId: string,
  path: string,
  { preview = false }: { preview?: boolean } = {},
): void {
  const current = byConversation.get(conversationId) ?? EMPTY

  if (current.paths.includes(path)) {
    byConversation.set(conversationId, {
      ...current,
      active: path,
      // Rouvrir explicitement ce qui n'était qu'un aperçu, c'est décider de le garder.
      preview: !preview && current.preview === path ? null : current.preview,
    })
    emit()
    return
  }

  // L'aperçu se remplace à sa place plutôt qu'en fin de barre : les onglets ouverts
  // avant lui ne doivent pas se déplacer à chaque fichier survolé.
  const replacing = preview && current.preview !== null ? current.paths.indexOf(current.preview) : -1
  const paths = [...current.paths]
  if (replacing === -1) paths.push(path)
  else paths[replacing] = path

  byConversation.set(conversationId, {
    paths,
    active: path,
    preview: preview ? path : current.preview,
  })
  emit()
}

/** Fait d'un aperçu un onglet ordinaire : le suivant ne le remplacera plus. */
export function pinTab(conversationId: string, path: string): void {
  const current = byConversation.get(conversationId) ?? EMPTY
  if (current.preview !== path) return
  byConversation.set(conversationId, { ...current, preview: null })
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
  const current = byConversation.get(conversationId) ?? EMPTY
  const paths = keep === null ? [] : [keep]
  byConversation.set(conversationId, {
    paths,
    active: keep,
    preview: current.preview === keep ? keep : null,
  })
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
    preview: current.preview === path ? null : current.preview,
  })
  emit()
}
