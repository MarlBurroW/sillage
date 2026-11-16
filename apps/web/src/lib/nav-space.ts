import { useState } from 'react'
import { useLocation } from 'react-router-dom'

/**
 * What the rail selects. A space is a place with its own destinations; the column lists what the
 * selected space holds, so nothing global competes with a project's sessions for height.
 */
export type NavSpace =
  | 'activity'
  | 'discussions'
  | 'benchmarks'
  | 'services'
  | 'consumption'
  | 'settings'
  | `project:${string}`

/**
 * Spaces that own a list get the column. Tool pages (services, consumption, settings) keep the full width: they
 * carry their own navigation and a session list beside them would name another space.
 */
export function hasColumn(space: NavSpace): boolean {
  return space === 'activity' || space === 'discussions' || space === 'benchmarks' || space.startsWith('project:')
}

export function projectOfSpace(space: NavSpace): string | null {
  return space.startsWith('project:') ? space.slice('project:'.length) : null
}

/** The space a path belongs to, or null for pages outside every space (project creation). */
export function routeSpace(pathname: string): NavSpace | null {
  const project = /^\/p\/([\w-]+)/.exec(pathname)?.[1]
  if (project) return `project:${project}`
  const head = pathname.split('/')[1]
  if (head === 'discussions' || head === 'benchmarks' || head === 'services' || head === 'consumption') return head
  // The skill editor is opened from the settings library and returns to it.
  if (head === 'settings' || head === 'skills') return 'settings'
  // Activity's own pages: the wall its list fills, and the decision history.
  if (head === 'wall' || head === 'decisions') return 'activity'
  return null
}

/**
 * Current space and the column to show. Beside the page, Activity is routed like any space: its
 * list fills the wall. In a phone drawer it is only a list to pick from, so `activity` keeps it
 * selected while the sessions it opens change the route, until another rail entry is chosen.
 */
export function useNavSpace(fallback: NavSpace | null): {
  space: NavSpace | null
  /** Last space that owned a column: what a phone drawer shows on a tool page. */
  columnSpace: NavSpace | null
  activity: boolean
  setActivity: (next: boolean) => void
} {
  const { pathname } = useLocation()
  const routed = routeSpace(pathname)
  const [activity, setActivity] = useState(false)
  // Adopted during render so the column never shows one frame of the previous space.
  const [remembered, setRemembered] = useState(routed)
  if (routed && routed !== remembered) setRemembered(routed)
  const [listed, setListed] = useState(routed && hasColumn(routed) ? routed : null)
  if (routed && hasColumn(routed) && routed !== listed) setListed(routed)

  const space = activity ? 'activity' : routed ?? remembered ?? fallback
  const columnSpace = space && hasColumn(space) ? space : listed ?? fallback
  return { space, columnSpace, activity, setActivity }
}
