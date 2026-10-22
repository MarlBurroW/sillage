import { z } from 'zod'
import { agentConfigSchema } from './agent-config.js'
import { agentKindSchema, type AgentKind } from './events.js'

/**
 * API tokens: what a machine client presents in `Authorization: Bearer`.
 *
 * Tokens unlock only `/api/v1`, while session cookies unlock only the rest. This clear boundary
 * lets UI DTOs evolve without becoming public contracts and prevents stolen tokens from
 * accessing account administration.
 */

/**
 * `tasks:autonomous` is the unrestricted-mode scope: only it permits configurations where the
 * CLI asks nothing (`bypassPermissions`, or Codex `never` + `danger-full-access`). A dedicated
 * scope rather than an option makes arbitrary-execution tokens visible and revocable as such.
 */
export const apiScopeSchema = z.enum([
  'projects:read',
  'projects:write',
  'tasks:read',
  'tasks:write',
  'tasks:autonomous',
  /**
   * Sillage's HTTP MCP server (`POST /api/v1/mcp`), with session tools acting on behalf of an
   * account: history, board, sessions, memory, launches. A separate scope because it exposes
   * more than tasks: instructions and memory are writable.
   */
  'mcp',
])
export type ApiScope = z.infer<typeof apiScopeSchema>

/** Cleartext prefix to recognize a token found in a configuration file. */
export const API_TOKEN_PREFIX = 'sillage_pat_'

export interface ApiTokenDto {
  id: string
  label: string
  /** First characters of the secret, the only part that can be shown again after creation. */
  hint: string
  scopes: ApiScope[]
  /** Allowed projects; empty means “all projects its user can see”. */
  projectIds: string[]
  agent: AgentKind
  config: unknown
  /** URL called on task events; null if the token requests none. */
  webhookUrl: string | null
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  revokedAt: number | null
}

/**
 * Authentication secret is returned only once, at creation: only its hash is stored. The
 * webhook secret signs server-side and remains readable in the database; it is shown only here
 * because the screen has no reason to expose it afterwards.
 */
export interface CreatedApiTokenDto {
  token: ApiTokenDto
  secret: string
  webhookSecret: string
}

/**
 * CLI and configuration are required: someone who understands the choice decides here, once,
 * what agents will use. Tasks then launch with just a prompt.
 */
export const createApiTokenBodySchema = z.object({
  label: z.string().min(1).max(120),
  scopes: z.array(apiScopeSchema).min(1),
  projectIds: z.array(z.string()).default([]),
  agent: agentKindSchema,
  config: agentConfigSchema,
  expiresAt: z.number().int().positive().nullable().default(null),
  /** Task webhook destination. Optional: polling remains complete without it. */
  webhookUrl: z.string().url().nullable().default(null),
})

/**
 * Tokens are revoked, not edited.
 *
 * Expanding scopes or changing CLI without changing the secret would grant distributed access
 * rights it did not have when issued. Recreating requires exchanging a new secret, exactly the
 * intended action.
 */
export const updateApiTokenBodySchema = z.object({
  revoked: z.literal(true),
})
