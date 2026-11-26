import type { ApiTokenRow, ConversationRow } from '@sillage/db'
import type { ZodError } from 'zod'
import { HttpError } from '../http/errors.js'

/** Shared by every agent request handler: the refusal the caller reads verbatim, the requester shape and error wording. */

/** A request refused for a reason the agent can correct; settled as an error without being logged as a failure. */
export class Refusal extends Error {}

/** Requester is a session or an account without sessions. Global MCP local clients (`docs/mcp.md`) supply `user_id` instead of conversations, with empty `id`, no worktree/task ancestry and no session-specific launch chains, provenance notes or decisions. Use `Pick` rather than whole rows so types expose only fields actually read. */
export type Requester = Pick<ConversationRow, 'id' | 'userId' | 'agent' | 'worktreeId' | 'scheduleId' | 'title'> & { projectId: string; personal?: boolean; apiToken?: ApiTokenRow; fromProject?: string }

export interface StartSessionPayload {
  prompt?: unknown
  title?: unknown
  agent?: unknown
  model?: unknown
  effort?: unknown
  worktree?: unknown
  card?: unknown
}

/** Interpolates HTTP error `{param}` placeholders because shared route errors are API-oriented but models read them verbatim. */
export function describeError(err: unknown): string {
  if (err instanceof HttpError) {
    return err.message.replace(/\{(\w+)\}/g, (_, key: string) => String(err.params?.[key] ?? key))
  }
  return err instanceof Error ? err.message : String(err)
}

export function describeZod(error: ZodError): string {
  const issues = error.issues.map((issue) => `\`${issue.path.join('.') || 'parameters'}\`: ${issue.message}`)
  return `Invalid parameters — ${issues.join('; ')}`
}
