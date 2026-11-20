import { projects, type Db } from '@sillage/db'
import { eq } from 'drizzle-orm'

/**
 * Refusal for a project session that targets another project while its own project keeps its
 * sessions inside it. It names the setting so the agent can tell the user how to allow it rather
 * than conclude the other project is out of reach. Same wording as `CROSS_PROJECTS_OFF` in
 * `apps/server/src/mcp/sillage-mcp.mjs`.
 */
export const CROSS_PROJECTS_SETTING =
  "to let this project's sessions read and act on the account's other projects, the project owner enables “Act on my other projects” on the project page, General tab (French interface: « Agir sur mes autres projets », tab « Général »). Tell the user about this setting instead of working around it."

export const CROSS_PROJECTS_OFF = `This session can only act within its own project. ${CROSS_PROJECTS_SETTING[0]!.toUpperCase()}${CROSS_PROJECTS_SETTING.slice(1)}`

/** Read on each request rather than at launch, so toggling the setting also applies to running sessions. */
export function crossProjectsEnabled(db: Db, projectId: string): boolean {
  return db.select({ open: projects.crossProjects }).from(projects).where(eq(projects.id, projectId)).get()?.open ?? false
}
