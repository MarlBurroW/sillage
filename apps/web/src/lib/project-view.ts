import { useEffect, useSyncExternalStore } from 'react'

/**
 * Project landing view remembered per project. Some projects use a board, others open a new
 * conversation; a global preference would suit only some, and repeatedly reopening boards through
 * menus gets tiresome. Stored in the browser unlike sidebar collapse: preferred landing views
 * depend on the current screen (board on desktop, new conversation on phone), while collapsed
 * projects represent current work priorities and follow the account across devices.
 */

const KEY = 'sillage.projectView'

export type ProjectView = 'board' | 'draft'

function read(): Record<string, ProjectView> {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') return {}
    // Filter values again: users can edit storage manually and unknown views would create invalid paths.
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, ProjectView] => entry[1] === 'board' || entry[1] === 'draft',
      ),
    )
  } catch {
    // An unreadable display preference does not warrant an error screen: fall back to defaults and
    // let the next visit write a valid value.
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
 * Remember the current project view, or nothing when `view` is null. Set by destination screens
 * rather than links: retain where users work, not which button led there. The null case matters:
 * starting from a card passes through the draft, which must not replace the board preference.
 * Otherwise the board's primary action would silently disable board landing every other visit.
 */
export function useRememberProjectView(
  projectId: string | undefined,
  view: ProjectView | null,
): void {
  useEffect(() => {
    if (projectId && view) setProjectView(projectId, view)
  }, [projectId, view])
}

/** Remembered project view read outside rendering for bulk link construction. */
export function projectViewOf(projectId: string): ProjectView {
  return views[projectId] ?? 'draft'
}

/** Project landing path based on its remembered view. */
export function projectViewPath(projectId: string, view: ProjectView): string {
  return view === 'board' ? `/p/${projectId}/board` : `/p/${projectId}/c/new`
}
