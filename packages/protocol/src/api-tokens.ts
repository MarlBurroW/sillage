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
   * Project tools, via REST or MCP, acting on behalf of an account: history, board,
   * sessions, memory, launches. Kept separate from tasks because instructions and memory
   * are writable. This is an action scope, not a transport gate.
   */
  'mcp',
])
export type ApiScope = z.infer<typeof apiScopeSchema>

/** Cleartext prefix to recognize a token found in a configuration file. */
export const API_TOKEN_PREFIX = 'sillage_pat_'

/** Null lists allow every value; empty lists never silently mean unrestricted. */
export const apiAgentPermissionSchema = z.object({
  agent: agentKindSchema,
  models: z.array(z.string().trim().min(1)).min(1).nullable().default(null),
  efforts: z.array(z.string().trim().min(1)).min(1).nullable().default(null),
  /** Claude's per-session spending cap; other CLIs do not enforce a dollar budget. */
  maxBudgetUsd: z.number().positive().nullable().default(null),
}).strict().refine((rule) => rule.agent === 'claude' || rule.maxBudgetUsd === null, {
  message: 'Dollar budgets are supported only by Claude.',
})
export const apiExecutionPolicySchema = z.object({
  agents: z.array(apiAgentPermissionSchema).min(1),
}).strict().refine((policy) => new Set(policy.agents.map((rule) => rule.agent)).size === policy.agents.length, {
  message: 'Each CLI must appear only once.',
})
export type ApiAgentPermission = z.infer<typeof apiAgentPermissionSchema>
export type ApiExecutionPolicy = z.infer<typeof apiExecutionPolicySchema>

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
  /** Null preserves unrestricted CLI/model/effort access for existing tokens. */
  executionPolicy: ApiExecutionPolicy | null
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
 * Defaults and permissions are separate: callers may override model and effort within the
 * execution policy. Omitting a policy retains the legacy unrestricted behavior.
 */
export const createApiTokenBodySchema = z.object({
  label: z.string().min(1).max(120),
  scopes: z.array(apiScopeSchema).min(1),
  projectIds: z.array(z.string()).default([]),
  agent: agentKindSchema,
  config: agentConfigSchema,
  executionPolicy: apiExecutionPolicySchema.nullable().default(null),
  expiresAt: z.number().int().positive().nullable().default(null),
  /** Task webhook destination. Optional: polling remains complete without it. */
  webhookUrl: z.string().url().nullable().default(null),
})

/** Cookie-authenticated owners may revise execution limits without redistributing a secret. */
export const updateApiTokenBodySchema = z.union([
  z.object({ revoked: z.literal(true) }).strict(),
  z.object({
    executionPolicy: apiExecutionPolicySchema,
    agent: agentKindSchema,
    config: agentConfigSchema,
  }).strict(),
])
