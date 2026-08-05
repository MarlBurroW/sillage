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
}

export const updateAppSettingsBodySchema = z.object({
  /**
   * Zéro coupe l'archivage automatique. La borne haute n'a rien de sacré, elle écarte
   * seulement les valeurs qui ne veulent rien dire pour un réglage exprimé en jours.
   */
  autoArchiveDays: z.number().int().min(0).max(3650).optional(),
  autoArchiveSchedule: cronScheduleSchema.optional(),
})
