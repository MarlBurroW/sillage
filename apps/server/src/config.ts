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

/**
 * Le fichier d'exemple et l'usage TOML courant écrivent `max_concurrent_sessions`,
 * mais le schéma est en camelCase. Sans cette passe, les clés snake_case étaient
 * silencieusement ignorées et l'utilisateur tournait sur les défauts en croyant
 * ses réglages appliqués. On accepte donc les deux graphies.
 */
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

  const parsed = configSchema.safeParse(camelizeKeys(raw))
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Configuration invalide (${configPath}):\n${issues}`)
  }

  const config = parsed.data

  // En conteneur, écrire un fichier TOML pour changer l'adresse d'écoute est
  // disproportionné : l'image Docker fixe SILLAGE_HOST=0.0.0.0 et l'utilisateur
  // ajuste le port par variable d'environnement.
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
