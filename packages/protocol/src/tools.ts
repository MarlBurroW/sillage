import { z } from 'zod'

export const toolPresentationSchema = z.object({
  origin: z.enum(['native', 'mcp']).optional(),
  title: z.string().optional(),
  label: z.string().optional(),
  paths: z.array(z.string()).optional(),
})
export type ToolPresentation = z.infer<typeof toolPresentationSchema>

/** Preserve harness-authored labels without treating a raw tool name as a description. */
export function toolPresentation(title: unknown, names: string[], locations?: unknown): ToolPresentation {
  const result: ToolPresentation = {}
  if (typeof title === 'string' && title.trim() && !names.some(name => name.toLowerCase() === title.trim().toLowerCase())) {
    result.title = title.trim().slice(0, 512)
  }
  if (Array.isArray(locations)) {
    const paths = locations.slice(0, 20).flatMap((location: unknown) => {
      const path = (location as { path?: unknown } | null)?.path
      return typeof path === 'string' && path.trim() ? [path.slice(0, 512)] : []
    })
    if (paths.length) result.paths = [...new Set(paths)]
  }
  return result
}

/**
 * Canonical tool names carried by `tool.started.name`.
 *
 * Previously undocumented except in a frontend view-registry comment, forcing adapter authors
 * to infer the contract from Codex's adapter. This definition is normative.
 *
 * Adapters MUST use these names for matching actions: Codex publishes command execution as
 * `Bash` and file changes as `Edit`. MCP tools pass through as `server/tool`; genuinely native
 * tools without equivalents retain their names and use the frontend's generic view.
 *
 * File-change detection never relies on these names: `file.edited` exists for that purpose.
 */
export const CANONICAL_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  /** `Task` and `Agent` name the same sub-agent tool depending on CLI version. */
  'Task',
  'Agent',
  'ExitPlanMode',
] as const

export type CanonicalToolName = (typeof CANONICAL_TOOLS)[number]

/** Both sub-agent tool names, grouped where the contract declares them. */
const SPAWN_TOOLS: ReadonlySet<string> = new Set<CanonicalToolName>(['Task', 'Agent'])

/** True if this call launches a sub-agent whose work is associated with it. */
export function isSpawnTool(name: string): boolean {
  return SPAWN_TOOLS.has(name)
}

/**
 * Claude Code's advisor (`/advisor`, probed on 2.1.332): the API runs it as a server tool named
 * `advisor`, so the call arrives as `server_tool_use` with an empty input, since the advisor model
 * rereads the whole conversation rather than answering a question, and its answer as an
 * `advisor_tool_result` block. The adapter journals the pair as an ordinary tool call under this
 * name, with an `AdvisorOutcome` as output.
 */
export const ADVISOR_TOOL = 'advisor'

/**
 * What one consultation gave. `advised` carries the advice; `redacted` means the API returned it
 * encrypted, readable by the model only (the usual case on a subscription); `refused` is an
 * advisor that declined; `unavailable` an API error, with its code.
 */
export interface AdvisorOutcome {
  status: 'advised' | 'redacted' | 'refused' | 'unavailable'
  text: string | null
  errorCode: string | null
  /** Model that answered, resolved by the API; null when its usage was not reported. */
  model: string | null
  /** Tokens the advisor model consumed for this consultation, billed apart from the main model. */
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } | null
}

const ADVISOR_STATUSES: ReadonlySet<string> = new Set(['advised', 'redacted', 'refused', 'unavailable'])

/** Reads a journaled advisor output back; null for anything else, so views can fall back. */
export function readAdvisorOutcome(value: unknown): AdvisorOutcome | null {
  if (!value || typeof value !== 'object') return null
  const outcome = value as Partial<AdvisorOutcome>
  return typeof outcome.status === 'string' && ADVISOR_STATUSES.has(outcome.status) ? {
    status: outcome.status,
    text: typeof outcome.text === 'string' ? outcome.text : null,
    errorCode: typeof outcome.errorCode === 'string' ? outcome.errorCode : null,
    model: typeof outcome.model === 'string' ? outcome.model : null,
    usage: outcome.usage && typeof outcome.usage === 'object' ? outcome.usage : null,
  } : null
}
