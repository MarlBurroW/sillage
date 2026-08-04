import { z } from 'zod'

/**
 * Réglages qui valent pour l'instance entière.
 *
 * Lisibles par tout compte connecté, modifiables par le seul administrateur : rien ici
 * n'est sensible, et l'interface a besoin de la valeur pour dire à chacun au bout de
 * combien de temps ses fils seront rangés.
 */
export interface AppSettingsDto {
  autoArchiveDays: number
}

export const updateAppSettingsBodySchema = z.object({
  /**
   * Zéro coupe l'archivage automatique. La borne haute n'a rien de sacré, elle écarte
   * seulement les valeurs qui ne veulent rien dire pour un réglage exprimé en jours.
   */
  autoArchiveDays: z.number().int().min(0).max(3650).optional(),
})
