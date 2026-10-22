import { eq } from 'drizzle-orm'
import { appSettings, type Db } from '@sillage/db'
import { cronScheduleSchema, type AppSettingsDto } from '@sillage/protocol'
import type { Config } from '../config.js'

export type AppSettings = AppSettingsDto

/** Instance settings including `config.toml` defaults. Database values override file values: the interface is the normal settings path; files provision new instances. Reread on every call because these settings are used for daily scheduled tasks or screen opening, never hot paths, and caching would require invalidation. Ignore stored values that no longer validate and use defaults: routes validate writes, but manually edited databases must not prevent startup. */
export function readAppSettings(db: Db, config: Config): AppSettings {
  const days = readValue(db, 'autoArchiveDays')
  const schedule = readValue(db, 'autoArchiveSchedule')
  const maxSessions = readValue(db, 'maxConcurrentSessions')
  const publicUrl = readValue(db, 'publicUrl')

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
    // Empty database strings are deliberate choices: infer from each request again,
    // even if the configuration file specifies an address.
    publicUrl: typeof publicUrl === 'string' ? publicUrl : config.server.publicUrl,
  }
}

/** Public root used in links, or empty to infer it from requests. Reread on every call like other settings: URLs configured in the tour or settings must appear immediately in subsequently copied webhook links. */
export function publicUrlOf(db: Db, config: Config): string {
  return readAppSettings(db, config).publicUrl
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
