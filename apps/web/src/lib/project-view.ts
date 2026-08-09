import { useEffect, useSyncExternalStore } from 'react'

/**
 * Écran d'accueil d'un projet, retenu projet par projet.
 *
 * Certains projets se pilotent au board, d'autres n'en ont aucun et s'ouvrent sur une
 * conversation neuve. Une préférence globale trancherait mal pour la moitié d'entre eux,
 * et rouvrir le board à chaque fois d'un menu use vite.
 *
 * La mémoire est locale au navigateur, comme le repli de la sidebar : c'est une
 * habitude de poste de travail, pas une propriété du projet que les autres comptes
 * auraient à subir.
 */

const KEY = 'sillage.projectView'

export type ProjectView = 'board' | 'draft'

function read(): Record<string, ProjectView> {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') return {}
    // Les valeurs sont refiltrées : la clé est éditable à la main, et une vue inconnue
    // produirait un chemin qui ne mène nulle part.
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, ProjectView] => entry[1] === 'board' || entry[1] === 'draft',
      ),
    )
  } catch {
    // Une préférence d'affichage illisible ne vaut pas d'écran d'erreur : on repart du
    // défaut, et la prochaine visite réécrit une valeur saine.
    return {}
  }
}

let views = read()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useProjectView(projectId: string): ProjectView {
  return useSyncExternalStore(
    subscribe,
    () => views[projectId] ?? 'draft',
    () => 'draft',
  )
}

export function setProjectView(projectId: string, view: ProjectView): void {
  if (views[projectId] === view) return
  views = { ...views, [projectId]: view }
  localStorage.setItem(KEY, JSON.stringify(views))
  for (const listener of listeners) listener()
}

/**
 * Retient la vue en cours pour ce projet, ou ne retient rien quand `view` est nul.
 *
 * Posé par les écrans concernés plutôt que par les liens qui y mènent : ce qui doit
 * être retenu est là où l'on travaille, et non le bouton par lequel on y est arrivé.
 *
 * D'où le cas nul, qui n'est pas un détail : lancer une session depuis une carte passe
 * par le brouillon, et l'y retenir ferait retomber sur le brouillon au prochain clic
 * sur le projet. Le geste le plus caractéristique du board aurait donc désarmé le
 * board, une fois sur deux, sans que personne ait rien demandé.
 */
export function useRememberProjectView(
  projectId: string | undefined,
  view: ProjectView | null,
): void {
  useEffect(() => {
    if (projectId && view) setProjectView(projectId, view)
  }, [projectId, view])
}

/** Chemin d'accueil d'un projet, d'après ce qui a été retenu pour lui. */
export function projectViewPath(projectId: string, view: ProjectView): string {
  return view === 'board' ? `/p/${projectId}/board` : `/p/${projectId}/c/new`
}
