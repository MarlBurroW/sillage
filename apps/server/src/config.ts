import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import { cronScheduleSchema } from '@sillage/protocol'

const configSchema = z.object({
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(7317),
      /** Public instance root for API response links. Empty infers from request `Host`, working with domains and local addresses. Setting it prevents forged Host values from generating links to another site that callers could forward to humans. */
      publicUrl: z.string().default(''),
    })
    .default({}),
  limits: z
    .object({
      /** Claude sessions cost 400–500 MB: this is the meaningful concurrency limit. Provisioning default only; interface values stored in the database override it (see `readAppSettings`). */
      maxConcurrentSessions: z.number().int().min(1).default(10),
      sessionIdleTimeoutMin: z.number().int().min(1).default(30),
      ptyIdleTimeoutMin: z.number().int().min(1).default(60),
      maxAttachmentBytes: z.number().int().default(20 * 1024 * 1024),
    })
    .default({}),
  retention: z
    .object({
      archivedEventsDays: z.number().int().min(1).default(90),
      /** Inactivity days before read, idle conversations are archived. Zero disables automatic archiving while retaining the manual action. */
      autoArchiveDays: z.number().int().min(0).default(14),
      /** Archival cron expression. Defaults to early morning, offset from other housekeeping to avoid four jobs competing for SQLite's sole writer. */
      autoArchiveSchedule: cronScheduleSchema.default('45 4 * * *'),
    })
    .default({}),
  mcp: z
    .object({
      /** Mounts Sillage MCP in conversations to expose project history. Enabled by default and globally disableable: some users want only a Claude Code/Codex interface without platform capabilities. When false, hide the interface entry too, since visible inoperative settings are worse than none. */
      sillageServer: z.boolean().default(true),
    })
    .default({}),
  skills: z
    .object({
      /** Delivers the Sillage skill library to sessions. Globally disableable for the same reason as `mcp.sillageServer`. */
      library: z.boolean().default(true),
    })
    .default({}),
  agents: z
    .object({
      claude: z
        .object({ binary: z.string().default('claude'), enabled: z.boolean().default(true) })
        .default({}),
      codex: z
        .object({ binary: z.string().default('codex'), enabled: z.boolean().default(true) })
        .default({}),
      opencode: z
        .object({ binary: z.string().default('opencode'), enabled: z.boolean().default(true) })
        .default({}),
      grok: z
        .object({ binary: z.string().default('grok'), enabled: z.boolean().default(true) })
        .default({}),
    })
    .default({}),
})

export type Config = z.infer<typeof configSchema> & { paths: Paths }

export interface Paths {
  data: string
  database: string
  attachments: string
  /** Managed CLI npm prefix under the data directory. Docker already mounts this volume, so CLIs survive container replacement without a second mount, and the directory already belongs to the service user. */
  agents: string
  worktrees: string
  logs: string
  /** Skill library; see `skill-library/layout.ts`. */
  skillLibrary: string
  /** Agent memory, one directory per project; see `memory/store.ts`. */
  memory: string
  /** Skill source clones live in cache rather than data: refresh rebuilds them, so backups need not carry them. */
  skillSourcesCache: string
  /** One `CODEX_HOME` per additional Codex account; see `codex-accounts/homes.ts`. */
  codexAccounts: string
  /** One `GROK_HOME` per additional Grok account; see `grok-accounts/homes.ts`. */
  grokAccounts: string
  /** One login per Claude subscription solely for usage gauges; see `claude-accounts/gauges.ts`. */
  claudeAccounts: string
  webRoot: string
}

/** Example files and conventional TOML use `max_concurrent_sessions`, but schemas use camelCase. Without normalization, snake_case keys were silently ignored while users assumed their settings applied. Accept both spellings. */
function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, val]) => [
      key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      camelizeKeys(val),
    ]),
  )
}

function xdg(envVar: string, fallback: string): string {
  const fromEnv = process.env[envVar]
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), fallback)
}

function resolvePaths(): Paths {
  const data = process.env.SILLAGE_DATA_DIR ?? join(xdg('XDG_DATA_HOME', '.local/share'), 'sillage')
  return {
    data,
    database: join(data, 'sillage.db'),
    attachments: join(data, 'attachments'),
    agents: join(data, 'agents'),
    worktrees: join(data, 'worktrees'),
    logs: join(data, 'logs'),
    skillLibrary: join(data, 'skill-library'),
    memory: join(data, 'memory'),
    codexAccounts: join(data, 'codex-accounts'),
    grokAccounts: join(data, 'grok-accounts'),
    claudeAccounts: join(data, 'claude-accounts'),
    // Per data directory: test servers beside daemons share preconfigured source IDs
    // but must not refresh
    // the same clone concurrently.
    skillSourcesCache: join(
      xdg('XDG_CACHE_HOME', '.cache'),
      'sillage',
      createHash('sha256').update(data).digest('hex').slice(0, 12),
      'skill-sources',
    ),
    webRoot: process.env.SILLAGE_WEB_ROOT ?? join(import.meta.dirname, '../../web/dist'),
  }
}

/** Missing configuration files are normal because every field has a default. Existing invalid files must fail startup rather than silently ignore settings users believe applied. */
export function loadConfig(): Config {
  const configPath =
    process.env.SILLAGE_CONFIG ?? join(xdg('XDG_CONFIG_HOME', '.config'), 'sillage/config.toml')

  let raw: unknown = {}
  try {
    raw = parseToml(readFileSync(configPath, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Configuration illisible (${configPath}): ${(err as Error).message}`)
    }
  }

  const parsed = configSchema.safeParse(camelizeKeys(raw))
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Configuration invalide (${configPath}):\n${issues}`)
  }

  const config = parsed.data

  // Containers should not need TOML files just to change bind addresses:
  // the Docker image sets SILLAGE_HOST=0.0.0.0 and users
  // adjust the port through environment variables.
  if (process.env.SILLAGE_HOST) config.server.host = process.env.SILLAGE_HOST
  if (process.env.SILLAGE_PORT) {
    const port = Number(process.env.SILLAGE_PORT)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`SILLAGE_PORT invalide: ${process.env.SILLAGE_PORT}`)
    }
    config.server.port = port
  }

  return { ...config, paths: resolvePaths() }
}
