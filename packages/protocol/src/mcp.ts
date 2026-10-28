import { z } from 'zod'

/**
 * MCP servers registered in Sillage.
 *
 * One model for both CLIs because declarations are identical: transport, connection and
 * authentication details. Application differs, not description; those differences live in
 * runners.
 *
 * Follows Claude SDK `McpServerConfigForProcessTransport`, the only serializable part of its
 * union: `sdk` servers contain in-memory instances and cannot be stored or transported.
 */

/**
 * The name reaches the CLI, which prefixes exposed tools with it (`mcp__<name>__<tool>`).
 * Spaces or dots break model-side tool resolution, hence validation here rather than silent
 * cleanup on write.
 */
export const mcpServerNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/)

/**
 * Name of the MCP server Sillage mounts in every conversation.
 *
 * Reserved: a registry entry with this name would silently replace it in the name-keyed table
 * built by both CLIs.
 */
export const BUILTIN_MCP_SERVER_NAME = 'sillage'

/** Codex merges thread overrides into user tables, so its built-in transport needs its own name. */
export const CODEX_BUILTIN_MCP_SERVER_NAME = 'sillage_builtin'

/**
 * Checked on registry writes, not in `mcpServerNameSchema`: the schema also reads existing
 * rows. Entries predating the reservation must remain readable for renaming rather than making
 * the table unusable.
 */
export function isReservedMcpServerName(name: string): boolean {
  return [BUILTIN_MCP_SERVER_NAME, CODEX_BUILTIN_MCP_SERVER_NAME].includes(name.toLowerCase())
}

const stdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /**
   * Adds to, rather than replaces, the Sillage server environment: MCP servers retain `HOME`
   * and `PATH` without copying them here. Verified on both CLIs.
   */
  env: z.record(z.string()).default({}),
})

const httpTransportSchema = z.object({
  /** `sse` is the legacy transport, still used by existing servers. */
  type: z.enum(['http', 'sse']),
  url: z.string().url(),
  headers: z.record(z.string()).default({}),
})

export const mcpTransportSchema = z.discriminatedUnion('type', [
  stdioTransportSchema,
  httpTransportSchema,
])
export type McpTransport = z.infer<typeof mcpTransportSchema>

export const mcpServerSchema = z.object({
  id: z.string(),
  name: mcpServerNameSchema,
  /**
   * Globally disabled: the server stays registered but is passed to no CLI. Avoids deleting and
   * re-entering it just to disable it during diagnostics.
   */
  enabled: z.boolean(),
  transport: mcpTransportSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type McpServer = z.infer<typeof mcpServerSchema>

/**
 * Server state as reported by the CLI.
 *
 * Vocabulary unified from two protocols that describe different things: Claude publishes
 * per-server status; Codex publishes startup and authentication states separately. Runners
 * reduce both to this shape.
 */
export const mcpServerStateSchema = z.enum([
  'pending',
  /** Passed to a CLI that does not report server health; a successful call confirms connection. */
  'configured',
  'connected',
  'failed',
  /** Server responds but requires authentication Sillage cannot perform. */
  'needs-auth',
  'disabled',
])
export type McpServerState = z.infer<typeof mcpServerStateSchema>

export const mcpServerStatusSchema = z.object({
  name: z.string(),
  state: mcpServerStateSchema,
  /**
   * Tools actually advertised by the server, not those expected. The only way users can verify
   * that a server does what they think it does.
   */
  tools: z.array(z.string()).default([]),
  error: z.string().nullable().default(null),
  /**
   * Server from CLI files (`~/.claude.json`, `config.toml`, claude.ai connectors), not Sillage.
   * The UI must show it without offering edits: Sillage does not own it.
   */
  external: z.boolean().default(false),
})
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>
