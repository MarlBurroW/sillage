import type { LibrarySkillScope } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { useProjects } from '../../lib/projects'
import { useCurrentUser } from '../../lib/session'

/** Writable scope offered by selectors. */
export interface SkillDestination {
  value: string
  label: string
  scope: LibrarySkillScope
  projectId: string | null
}

/**
 * Library write permissions mirror server rules: global for administrators, projects for owners.
 * Server enforcement remains authoritative; this avoids offering doomed actions.
 */
export function useSkillPermissions() {
  const t = useTranslate()
  const { data: me } = useCurrentUser()
  const { data: projects = [] } = useProjects()
  const isAdmin = me?.isAdmin === true
  const owned = projects.filter((project) => project.isOwner && project.archivedAt === null)

  const canWrite = (scope: LibrarySkillScope, projectId: string | null): boolean =>
    scope === 'global' ? isAdmin : owned.some((project) => project.id === projectId)

  const destinations: SkillDestination[] = [
    ...(isAdmin ? [{ value: 'global', label: t('skills.scope.global'), scope: 'global' as const, projectId: null }] : []),
    ...owned.map((project) => ({
      value: project.id,
      label: t('skills.scope.projectNamed', { name: project.name }),
      scope: 'project' as const,
      projectId: project.id,
    })),
  ]

  const projectName = (projectId: string | null): string | null =>
    projects.find((project) => project.id === projectId)?.name ?? null

  return { isAdmin, canWrite, destinations, projectName }
}
