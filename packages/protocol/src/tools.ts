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
