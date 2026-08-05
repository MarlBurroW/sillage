import { eq } from 'drizzle-orm'
import { appSettings, type Db } from '@sillage/db'
import { cronScheduleSchema, type AppSettingsDto } from '@sillage/protocol'
import type { Config } from '../config.js'

export type AppSettings = AppSettingsDto

/**
 * Les réglages d'instance, défauts du `config.toml` compris.
 *
 * La base l'emporte sur le fichier quand la clé y est posée : l'interface est le
 * moyen normal de régler, le fichier reste celui de provisionner une instance neuve.
 *
 * Relu à chaque appel plutôt que gardé en cache : ces réglages se lisent une fois par
 * jour dans une tâche planifiée et à l'ouverture d'un écran, jamais dans un chemin
 * chaud, et un cache aurait à s'invalider depuis l'écriture.
 *
 * Une valeur stockée qui ne passe plus la validation est ignorée au profit du défaut.
 * Le cas ne devrait pas arriver, les routes validant à l'écriture, mais une base
 * éditée à la main ne doit pas pouvoir empêcher le serveur de démarrer.
 */
export function readAppSettings(db: Db, config: Config): AppSettings {
  const days = readValue(db, 'autoArchiveDays')
  const schedule = readValue(db, 'autoArchiveSchedule')

  return {
    autoArchiveDays:
      typeof days === 'number' && Number.isInteger(days) && days >= 0
        ? days
        : config.retention.autoArchiveDays,
    autoArchiveSchedule:
      typeof schedule === 'string' && cronScheduleSchema.safeParse(schedule).success
        ? schedule
        : config.retention.autoArchiveSchedule,
  }
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

function readValue(db: Db, key: string): unknown {
  const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get()
  if (!row) return undefined

  try {
    return JSON.parse(row.value)
  } catch {
    // Une valeur illisible vaut absente : le défaut reprend la main, et la prochaine
    // écriture depuis l'interface la remplacera.
    return undefined
  }
}
