import { eq } from 'drizzle-orm'
import { appSettings, type Db } from '@sillage/db'
import { cronScheduleSchema, sanitizeAgentToolSettings, type AppSettingsDto } from '@sillage/protocol'
import type { Config } from '../config.js'

export type AppSettings = AppSettingsDto

/** Instance settings including `config.toml` defaults. Database values override file values: the interface is the normal settings path; files provision new instances. Reread on every call because these settings are used for daily scheduled tasks or screen opening, never hot paths, and caching would require invalidation. Ignore stored values that no longer validate and use defaults: routes validate writes, but manually edited databases must not prevent startup. */
export function readAppSettings(db: Db, config: Config): AppSettings {
  const days = readValue(db, 'autoArchiveDays')
  const schedule = readValue(db, 'autoArchiveSchedule')
  const maxSessions = readValue(db, 'maxConcurrentSessions')

  return {
    autoArchiveDays:
      typeof days === 'number' && Number.isInteger(days) && days >= 0
        ? days
        : config.retention.autoArchiveDays,
    autoArchiveSchedule:
      typeof schedule === 'string' && cronScheduleSchema.safeParse(schedule).success
        ? schedule
        : config.retention.autoArchiveSchedule,
    sttBaseUrl: readString(db, 'sttBaseUrl'),
    sttModel: readString(db, 'sttModel'),
    sttSecret: readString(db, 'sttSecret'),
    sttCleanupModel: readString(db, 'sttCleanupModel'),
    maxConcurrentSessions:
      typeof maxSessions === 'number' && Number.isInteger(maxSessions) && maxSessions >= 1
        ? maxSessions
        : config.limits.maxConcurrentSessions,
    publicUrl: publicUrlOf(db, config),
    agentTools: sanitizeAgentToolSettings(readValue(db, 'agentTools')),
    previewDomain: previewDomainOf(db, config),
  }
}

/** Public root for links and browser-origin checks. Read only this setting on the HTTP hot path; changes in onboarding and settings must take effect immediately. */
export function publicUrlOf(db: Db, config: Config): string {
  const publicUrl = readValue(db, 'publicUrl')
  // Empty database strings deliberately restore inference, including when the
  // configuration file specifies an address.
  return typeof publicUrl === 'string' ? publicUrl : config.server.publicUrl
}

/** Read on each preview request: changing the domain applies without a restart. */
export function previewDomainOf(db: Db, config: Config): string {
  const value = readValue(db, 'previewDomain')
  // Optional chaining: partial configurations (tests, older provisioning code) omit the section.
  return typeof value === 'string' ? value : config.previews?.domain ?? ''
}

export function writeAppSettings(db: Db, patch: Partial<AppSettings>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue

    const now = Date.now()
    const serialized = JSON.stringify(value)
    db.insert(appSettings)
      .values({ key, value: serialized, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: serialized, updatedAt: now } })
      .run()
  }
}

/** Empty-string defaults: these settings have no provisioning values. */
function readString(db: Db, key: string): string {
  const value = readValue(db, key)
  return typeof value === 'string' ? value : ''
}

function readValue(db: Db, key: string): unknown {
  const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get()
  if (!row) return undefined

  try {
    return JSON.parse(row.value)
  } catch {
    // Treat unreadable values as absent: defaults take over and the next
    // interface write replaces them.
    return undefined
  }
}

/** Desktop remote access through Tailscale Serve; see `remote-access/service.ts`. Kept out of `AppSettingsDto`: it is an action with checks and side effects (Serve), not a value the generic settings form patches. */
export interface RemoteAccessSettings {
  enabled: boolean
  /** Tailnet hostname the guard accepts in `Host`, recorded when enabling. */
  hostname: string | null
  /** Tailnet login allowed to open sessions, recorded when enabling. */
  login: string | null
}

export function readRemoteAccess(db: Db): RemoteAccessSettings {
  const raw = readValue(db, 'remoteAccess') as Partial<RemoteAccessSettings> | undefined
  const hostname = typeof raw?.hostname === 'string' && raw.hostname ? raw.hostname : null
  const login = typeof raw?.login === 'string' && raw.login ? raw.login : null
  // Both are needed to accept anyone: a partial record disables rather than opens.
  return { enabled: raw?.enabled === true && hostname !== null && login !== null, hostname, login }
}

export function writeRemoteAccess(db: Db, settings: RemoteAccessSettings): void {
  const now = Date.now()
  const serialized = JSON.stringify(settings)
  db.insert(appSettings)
    .values({ key: 'remoteAccess', value: serialized, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: serialized, updatedAt: now } })
    .run()
}
