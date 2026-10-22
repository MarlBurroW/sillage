/**
 * Sillage MCP tools under each CLI's naming convention. The same call is
 * `mcp__sillage__schedule_task` in Claude, `sillage/schedule_task` in Codex (`server/tool`, see
 * `codex/item-events.ts`), and `sillage_schedule_task` in OpenCode. Recognize all three.
 */
export function isSillageTool(name: string, tool: string): boolean {
  return name === `mcp__sillage__${tool}` || name === `sillage/${tool}` || name === `sillage_${tool}`
}

/** Task ID returned by `schedule_task` in its creation response: id followed by a UUID. */
export function scheduledTaskIdOf(output: string | null): string | null {
  return output?.match(/créée, id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1] ?? null
}
