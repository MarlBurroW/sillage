import { eq } from 'drizzle-orm'
import { appSettings, type Db } from '@sillage/db'
import type { Config } from '../config.js'

export interface AppSettings {
  /** Jours d'inactivité avant archivage automatique. Zéro le coupe. */
  autoArchiveDays: number
}

const AUTO_ARCHIVE_DAYS = 'autoArchiveDays'

/**
 * Les réglages d'instance, défauts du `config.toml` compris.
 *
 * La base l'emporte sur le fichier quand la clé y est posée : l'interface est le
 * moyen normal de régler, le fichier reste celui de provisionner une instance neuve.
 *
 * Relu à chaque appel plutôt que gardé en cache : ces réglages se lisent une fois par
 * jour dans une tâche planifiée et à l'ouverture d'un écran, jamais dans un chemin
 * chaud, et un cache aurait à s'invalider depuis l'écriture.
 */
export function readAppSettings(db: Db, config: Config): AppSettings {
  const row = db.select().from(appSettings).where(eq(appSettings.key, AUTO_ARCHIVE_DAYS)).get()
  const stored = row ? Number(JSON.parse(row.value)) : Number.NaN

  return {
    autoArchiveDays: Number.isInteger(stored) && stored >= 0
      ? stored
      : config.retention.autoArchiveDays,
  }
}

export function writeAppSettings(db: Db, patch: Partial<AppSettings>): void {
  if (patch.autoArchiveDays === undefined) return

  const now = Date.now()
  db.insert(appSettings)
    .values({ key: AUTO_ARCHIVE_DAYS, value: JSON.stringify(patch.autoArchiveDays), updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: JSON.stringify(patch.autoArchiveDays), updatedAt: now },
    })
    .run()
}
