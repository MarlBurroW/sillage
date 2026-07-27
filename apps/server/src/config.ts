import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'

const configSchema = z.object({
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(7317),
    })
    .default({}),
  limits: z
    .object({
      /** Une session Claude coûte 400 à 500 Mo. C'est le seul plafond qui compte. */
      maxConcurrentSessions: z.number().int().min(1).default(3),
      sessionIdleTimeoutMin: z.number().int().min(1).default(30),
      ptyIdleTimeoutMin: z.number().int().min(1).default(60),
      maxAttachmentBytes: z.number().int().default(20 * 1024 * 1024),
    })
    .default({}),
  retention: z
    .object({
      archivedEventsDays: z.number().int().min(1).default(90),
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
    })
    .default({}),
})

export type Config = z.infer<typeof configSchema> & { paths: Paths }

export interface Paths {
  data: string
  database: string
  attachments: string
  worktrees: string
  logs: string
  webRoot: string
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
    worktrees: join(data, 'worktrees'),
    logs: join(data, 'logs'),
    webRoot: process.env.SILLAGE_WEB_ROOT ?? join(import.meta.dirname, '../../web/dist'),
  }
}

/**
 * Un fichier de configuration absent est normal : tous les champs ont un défaut.
 * En revanche un fichier présent mais invalide doit faire échouer le démarrage,
 * sinon on tourne silencieusement avec des réglages que l'utilisateur croit appliqués.
 */
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

  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Configuration invalide (${configPath}):\n${issues}`)
  }

  return { ...parsed.data, paths: resolvePaths() }
}
