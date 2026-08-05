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
      /**
       * Racine publique de l'instance, pour les liens que l'API met dans ses réponses.
       *
       * Vide, elle se déduit de l'en-tête `Host` de la requête, ce qui marche aussi bien
       * par le nom de domaine que par l'adresse locale. La renseigner ferme le cas où un
       * appelant forge ce `Host` pour obtenir un lien vers un autre site, qu'il ferait
       * ensuite suivre à un humain.
       */
      publicUrl: z.string().default(''),
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
      /**
       * Jours d'inactivité au bout desquels une conversation lue et au repos est
       * rangée. Zéro coupe le rangement automatique, l'action manuelle restant là.
       */
      autoArchiveDays: z.number().int().min(0).default(14),
      /**
       * Motif cron du passage d'archivage. Au petit matin par défaut, et décalé des
       * autres ménages pour ne pas se retrouver à quatre sur l'unique rédacteur SQLite.
       */
      autoArchiveSchedule: cronScheduleSchema.default('45 4 * * *'),
    })
    .default({}),
  mcp: z
    .object({
      /**
       * Monte le serveur MCP de Sillage dans les conversations, qui ouvre à l'agent
       * l'historique du projet.
       *
       * Vrai par défaut, et coupable ici pour toute l'instance : certains ne veulent de
       * Sillage qu'une interface à Claude Code et Codex, sans les capacités que la
       * plateforme ajoute par-dessus. À faux, l'entrée disparaît aussi de l'interface,
       * un réglage visible mais inopérant valant moins que pas de réglage du tout.
       */
      sillageServer: z.boolean().default(true),
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
  /**
   * Préfixe npm où Sillage installe les CLI qu'il gère lui-même.
   *
   * Sous le répertoire de données, et non ailleurs : en Docker c'est déjà le volume
   * monté, donc les CLI survivent au remplacement du conteneur sans qu'il faille en
   * monter un second, et le dossier appartient déjà à l'utilisateur du service.
   */
  agents: string
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
    agents: join(data, 'agents'),
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
