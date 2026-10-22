import { z } from 'zod'
import type { TerminalDto } from './terminal.js'

/**
 * Project actions: buttons that run a command in the project directory.
 *
 * Maintained by Sillage, never written into the repository: everyone has their own tooling, and
 * a tracked `.sillage/` would impose it on everyone who clones.
 *
 * Two kinds, with different lifecycles:
 * - `task`: a one-off command (tests, seed, build) in a panel terminal; it exits and leaves its
 * screen and exit code.
 * - `service`: a long-running command (dev server, worker), backed by a `sillage-app-*` systemd
 * unit to outlive the daemon and appear in Services. Without user systemd (macOS, containers),
 * it falls back to a terminal.
 *
 * Limits live here because the form displays them and the `register_action` MCP tool must
 * reject the same inputs as the route.
 */

export const MAX_ACTION_LABEL_CHARS = 60
export const MAX_ACTION_DESCRIPTION_CHARS = 300
export const MAX_ACTION_COMMAND_CHARS = 4000
export const MAX_ACTION_SUBDIR_CHARS = 300
export const MAX_ACTION_URL_CHARS = 500
/** Beyond this, it is a Makefile rather than a button bar. */
export const MAX_ACTIONS_PER_PROJECT = 30

export const projectActionKindSchema = z.enum(['task', 'service'])
export type ProjectActionKind = z.infer<typeof projectActionKindSchema>

/**
 * Subdirectory relative to the worktree where the command runs. Relative and without `..`: an
 * action follows the conversation's worktree; an absolute path would always run in the same
 * place.
 */
export const actionSubdirSchema = z
  .string()
  .trim()
  .max(MAX_ACTION_SUBDIR_CHARS)
  .refine((value) => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'), {
    message: 'Relative path inside the project, without "..".',
  })

/**
 * Address to open a service, linked from the UI. `{port}` is replaced with the first listening
 * port, so the agent need not guess which port a dev server chose. It must be reachable from
 * the user's browser, often ruling out `localhost` when Sillage runs elsewhere.
 */
export const actionUrlSchema = z
  .string()
  .trim()
  .max(MAX_ACTION_URL_CHARS)
  .refine((value) => value === '' || isHttpUrl(value.replaceAll('{port}', '1')), {
    message: 'An http(s) URL, optionally with {port}.',
  })

/** Avoid `URL`, absent from this package's types shared between browser and server. */
function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i.test(value)
}

/**
 * URL to open, or null if there is no template, or it contains `{port}` while the service has
 * no listening port yet.
 */
export function resolveActionUrl(template: string | null, ports: readonly number[]): string | null {
  if (!template) return null
  if (!template.includes('{port}')) return template
  const port = ports[0]
  return port === undefined ? null : template.replaceAll('{port}', String(port))
}

export const createProjectActionBodySchema = z.object({
  label: z.string().trim().min(1).max(MAX_ACTION_LABEL_CHARS),
  description: z.string().trim().max(MAX_ACTION_DESCRIPTION_CHARS).optional(),
  kind: projectActionKindSchema,
  command: z.string().trim().min(1).max(MAX_ACTION_COMMAND_CHARS),
  subdir: actionSubdirSchema.optional(),
  url: actionUrlSchema.optional(),
})
export type CreateProjectActionBody = z.infer<typeof createProjectActionBodySchema>

export const updateProjectActionBodySchema = createProjectActionBodySchema.partial()
export type UpdateProjectActionBody = z.infer<typeof updateProjectActionBodySchema>

/** From a conversation, the action runs in its worktree; otherwise at the project root. */
export const runProjectActionBodySchema = z.object({
  conversationId: z.string().min(1).optional(),
})

export const serviceActionControlSchema = z.enum(['stop', 'restart'])
export type ServiceActionControl = z.infer<typeof serviceActionControlSchema>

/** State of a systemd-backed `service` action. */
export interface ProjectActionServiceState {
  unit: string
  /** systemd `ActiveState`; `inactive` when the unit does not exist. */
  state: string
  cwd: string | null
  ports: number[]
  startedAt: number | null
}

export interface ProjectActionDto {
  id: string
  projectId: string
  label: string
  description: string | null
  kind: ProjectActionKind
  command: string
  subdir: string | null
  /** Service URL template, including `{port}`; null for no link. */
  url: string | null
  /**
   * `proposed`: written or modified by an agent and not yet reviewed. Clicking runs the command
   * outside any session: show it before its first execution so prompt injection cannot sneak in
   * something we would run unseen.
   */
  status: 'approved' | 'proposed'
  /** Conversation that last created or modified it; null from the UI. */
  agentConversationId: string | null
  /** Its title, identifying the source of an action awaiting review; null if deleted. */
  agentConversationTitle: string | null
  createdAt: number
  updatedAt: number
  /** Null for a `task`, or when systemd is unavailable. */
  service: ProjectActionServiceState | null
  /** Latest terminal run, while its tab remains open. */
  lastRun: ProjectActionLastRun | null
}

export interface ProjectActionLastRun {
  terminalId: string
  alive: boolean
  /** Null while running, or if a daemon restart interrupted it. */
  exitCode: number | null
  startedAt: number
}

/** Execution result: the opened terminal or started unit. */
export interface ProjectActionRunResult {
  terminal: TerminalDto | null
  service: ProjectActionServiceState | null
  /** A previous run is still active: return it instead of launching another. */
  alreadyRunning: boolean
}
