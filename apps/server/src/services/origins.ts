import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface Origin {
  projectId: string
  conversationId: string | null
}

/** Un identifiant opaque hérité par les enfants ; le registre survit au daemon. */
export class ProcessOrigins {
  private readonly entries = new Map<string, Origin>()
  private readonly directory: string

  constructor(dataDirectory: string) {
    this.directory = join(dataDirectory, 'process-origins')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    for (const file of readdirSync(this.directory)) {
      if (!file.endsWith('.json')) continue
      try {
        const origin = JSON.parse(readFileSync(join(this.directory, file), 'utf8')) as Origin
        if (typeof origin.projectId === 'string' &&
          (origin.conversationId === null || typeof origin.conversationId === 'string')) {
          this.entries.set(file.slice(0, -5), origin)
        }
      } catch { /* Une entrée illisible ne doit pas empêcher les agents de démarrer. */ }
    }
  }

  environment(projectId: string, conversationId: string | null): Record<string, string> {
    for (const [token, entry] of this.entries) {
      if (entry.projectId === projectId && entry.conversationId === conversationId) {
        return { SILLAGE_PROCESS_ORIGIN: token }
      }
    }
    const token = randomUUID()
    const origin = { projectId, conversationId }
    writeFileSync(join(this.directory, `${token}.json`), JSON.stringify(origin), { mode: 0o600, flag: 'wx' })
    this.entries.set(token, origin)
    return { SILLAGE_PROCESS_ORIGIN: token }
  }

  resolve(environment: string): Origin | null {
    const token = environment.split('\0').find((entry) => entry.startsWith('SILLAGE_PROCESS_ORIGIN='))
      ?.slice('SILLAGE_PROCESS_ORIGIN='.length)
    return token ? this.byToken(token) : null
  }

  /** Le jeton déjà extrait, tel que l'environnement d'une unité systemd le donne. */
  byToken(token: string): Origin | null {
    return this.entries.get(token) ?? null
  }
}

const registries = new Map<string, ProcessOrigins>()
export function processOrigins(dataDirectory: string): ProcessOrigins {
  let registry = registries.get(dataDirectory)
  if (!registry) {
    registry = new ProcessOrigins(dataDirectory)
    registries.set(dataDirectory, registry)
  }
  return registry
}
