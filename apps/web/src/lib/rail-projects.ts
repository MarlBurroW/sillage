import type { ProjectDto } from '@sillage/protocol'
import { useEffect, useMemo } from 'react'
import { useSetPins } from './projects'

/** Projects the rail shows when none is pinned: enough to switch between current work. */
const UNPINNED_SHOWN = 6

/** Which projects the rail holds, and the one way to change that. */
export interface RailProjects {
  /** Projects kept in the rail, in the account's order. */
  kept: ProjectDto[]
  /**
   * The open project when the rail does not keep it: shown apart for as long as it is open, or
   * its column would have no entry to fold it from.
   */
  visiting: ProjectDto | undefined
  isKept: (projectId: string) => boolean
  /** False for the last project kept: an emptied rail would fill itself with recent ones again. */
  canRemove: boolean
  setKept: (project: ProjectDto, kept: boolean) => void
}

/**
 * Pins choose the rail. Without any, recent projects then the first ones stand in so the rail is
 * never empty, and the open project counts among them.
 */
export function railSelection(projects: ProjectDto[], recent: string[], currentId: string | null): { explicit: boolean; kept: ProjectDto[]; visiting: ProjectDto | undefined } {
  const pinned = projects.filter((project) => project.pinned)
  const current = projects.find((project) => project.id === currentId)
  if (pinned.length > 0) return { explicit: true, kept: pinned, visiting: current && !current.pinned ? current : undefined }
  const known = new Set(projects.map((project) => project.id))
  const shown = new Set([...new Set([...recent.filter((id) => known.has(id)), ...known])].slice(0, UNPINNED_SHOWN))
  if (current) shown.add(current.id)
  return { explicit: false, kept: projects.filter((project) => shown.has(project.id)), visiting: undefined }
}

export function useRailProjects(projects: ProjectDto[] | undefined, visits: { projectId: string }[], currentId: string | null): RailProjects {
  const setPins = useSetPins()
  const { mutate } = setPins
  return useMemo(() => {
    const { explicit, kept, visiting } = railSelection(projects ?? [], visits.map((visit) => visit.projectId), currentId)
    const ids = new Set(kept.map((project) => project.id))
    return {
      kept,
      visiting,
      isKept: (projectId) => ids.has(projectId),
      canRemove: kept.length > 1,
      setKept: (project, value) => {
        if (ids.has(project.id) === value || (!value && kept.length <= 1)) return
        if (explicit) return mutate([{ id: project.id, pinned: value }])
        // The first choice writes down the rail as it stands, changed by this one project:
        // pinning it alone would drop every project the rail was showing unasked.
        const next = new Set(ids)
        if (value) next.add(project.id)
        else next.delete(project.id)
        mutate([...next].map((id) => ({ id, pinned: true })))
      },
    }
  }, [projects, visits, currentId, mutate])
}

/** Pins once lived in the browser: move them to the server, then drop the key so they never replay. */
export function useLegacyPinMigration(userId: string, projects: ProjectDto[] | undefined): void {
  const { mutate } = useSetPins()
  const loaded = (projects?.length ?? 0) > 0
  useEffect(() => {
    if (!userId || !projects?.length) return
    const storageKey = `sillage.pinnedProjects:${userId}`
    try {
      const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
      if (value === null) return
      localStorage.removeItem(storageKey)
      if (!Array.isArray(value)) return
      const pins = projects.filter((project) => value.includes(project.id) && !project.pinned).map((project) => ({ id: project.id, pinned: true }))
      if (pins.length > 0) mutate(pins)
    } catch { /* Optional storage. */ }
    // Run once per account: list-change reruns would repin projects.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, loaded])
}
