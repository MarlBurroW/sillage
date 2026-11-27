import { CODEX_BUILTIN_MCP_SERVER_NAME } from '@sillage/protocol'

/**
 * Sillage MCP tools under each CLI's naming convention. The same call is
 * `mcp__sillage__schedule_task` in Claude, `sillage_builtin/schedule_task` in Codex (`server/tool`, see
 * `codex/item-events.ts`), and `sillage_schedule_task` in OpenCode. Keep legacy Codex names readable as well.
 */
export function isSillageTool(name: string, tool: string): boolean {
  return name === `${CODEX_BUILTIN_MCP_SERVER_NAME}/${tool}` || name === `mcp__sillage__${tool}` || name === `sillage/${tool}` || name === `sillage_${tool}`
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/**
 * Task ID returned by `schedule_task` in its creation response: id followed by a UUID. Replies are
 * in English since October 2026; older journals hold the French wording.
 */
export function scheduledTaskIdOf(output: string | null): string | null {
  return output?.match(new RegExp(`(?:created|créée), id (${UUID})`))?.[1] ?? null
}

/** Action a `register_action` call created (ID in its reply) or updated (ID in its input). */
export function registeredActionIdOf(input: unknown, output: string | null): string | null {
  const updated = (input as { id?: unknown } | null)?.id
  if (typeof updated === 'string' && new RegExp(`^${UUID}$`).test(updated)) return updated
  return output?.match(new RegExp(`, id (${UUID})\\) proposed`))?.[1] ?? null
}
