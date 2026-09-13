import { Cron } from 'croner'
import { z } from 'zod'

/**
 * Motif cron à cinq champs, validé par la bibliothèque qui l'exécutera.
 *
 * Croner plutôt qu'une expression régulière : `31 2 * * *` et `0 0 30 2 *` se
 * ressemblent, mais le second ne tombe jamais. Seul ce qui sait calculer une
 * prochaine occurrence peut faire la différence.
 */
export const cronScheduleSchema = z.string().refine(
  (value) => {
    try {
      return new Cron(value, { paused: true }).nextRun() !== null
    } catch {
      return false
    }
  },
  { message: 'Invalid cron expression.' },
)

/**
 * Réglages qui valent pour l'instance entière.
 *
 * Lisibles par tout compte connecté, modifiables par le seul administrateur : rien ici
 * n'est sensible, et l'interface a besoin de la valeur pour dire à chacun au bout de
 * combien de temps ses fils seront rangés.
 */
export interface AppSettingsDto {
  autoArchiveDays: number
  autoArchiveSchedule: string
  /**
   * Dictée vocale, sur toute API au format OpenAI (`/audio/transcriptions`).
   *
   * `sttSecret` est le nom d'un secret du dépôt, jamais la clé elle-même : la valeur
   * ne circule pas hors du serveur. Les trois premiers champs vides coupent la dictée,
   * `sttCleanupModel` vide coupe seulement la passe de nettoyage.
   */
  sttBaseUrl: string
  sttModel: string
  sttSecret: string
  sttCleanupModel: string
  /**
   * Runners CLI vivants en même temps, tous comptes confondus.
   *
   * Ce que ça plafonne est la mémoire de la machine, pas le nombre de conversations
   * ouvertes : au-delà, le serveur arrête le runner au repos le plus ancien, qui
   * repart en reprise au message suivant.
   */
  maxConcurrentSessions: number
}

/** Résultat d'un passage d'archivage lancé à la main. */
export interface ArchiveRunDto {
  archived: number
}

export const updateAppSettingsBodySchema = z.object({
  /**
   * Zéro coupe l'archivage automatique. La borne haute n'a rien de sacré, elle écarte
   * seulement les valeurs qui ne veulent rien dire pour un réglage exprimé en jours.
   */
  autoArchiveDays: z.number().int().min(0).max(3650).optional(),
  autoArchiveSchedule: cronScheduleSchema.optional(),
  // La chaîne vide est une valeur légitime partout : elle désactive.
  sttBaseUrl: z
    .string()
    .trim()
    .refine((value) => value === '' || /^https?:\/\//.test(value), {
      message: 'Base URL must start with http:// or https://.',
    })
    .optional(),
  sttModel: z.string().trim().max(200).optional(),
  sttSecret: z.string().trim().max(200).optional(),
  sttCleanupModel: z.string().trim().max(200).optional(),
  /**
   * Au moins une session, sinon plus rien ne peut démarrer. La borne haute écarte les
   * valeurs qui feraient tomber la machine avant d'être atteintes : à 400-500 Mo la
   * session, cent runners demanderaient 50 Go.
   */
  maxConcurrentSessions: z.number().int().min(1).max(100).optional(),
})

/** Résultat d'une dictée transcrite. */
export interface TranscriptionDto {
  text: string
}
