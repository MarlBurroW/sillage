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
