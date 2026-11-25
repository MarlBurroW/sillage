import { eq } from 'drizzle-orm'
import { projects, type Db } from '@sillage/db'
import { resolveAgentTools, sanitizeAgentToolSettings, type AgentToolFamily, type AgentToolSettings } from '@sillage/protocol'
import type { Config } from '../config.js'
import { readAppSettings } from '../settings/app-settings.js'

/** Stored project JSON, tolerant of hand edits like every other settings reader. */
export function readProjectAgentTools(raw: string | null | undefined): AgentToolSettings {
  if (!raw) return {}
  try {
    return sanitizeAgentToolSettings(JSON.parse(raw))
  } catch {
    return {}
  }
}

/**
 * Families a session launching now receives. Read at each launch rather than cached: a switch
 * applies to the next runner start, the same moment MCP servers are resolved. Personal
 * discussions (no project) follow the instance defaults.
 */
export function agentToolsFor(db: Db, config: Config, projectId: string | null): Record<AgentToolFamily, boolean> {
  const instance = readAppSettings(db, config).agentTools
  const project = projectId === null
    ? null
    : readProjectAgentTools(db.select({ agentTools: projects.agentTools }).from(projects).where(eq(projects.id, projectId)).get()?.agentTools)
  return resolveAgentTools(instance, project)
}
