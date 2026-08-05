import { Cron } from 'croner'
import cronstrue from 'cronstrue/i18n'

/**
 * Lecture humaine d'un motif cron, et prochains passages.
 *
 * Un champ où l'on écrit `45 4 * * *` sans rien d'autre à l'écran est un piège : la
 * faute de frappe ne se voit qu'à l'exécution, le lendemain, et par son absence. La
 * phrase et les trois prochaines dates sont ce qui rend le motif vérifiable au moment
 * où on l'écrit.
 *
 * Calculé dans le navigateur : c'est ce qui met l'aperçu à jour à la frappe, sans
 * aller-retour. Contrepartie assumée, les dates sont celles du poste et non du serveur,
 * ce que l'écran dit.
 */

/** Null quand le motif est invalide, ce qui en fait aussi le test de validité. */
export function cronToHuman(expression: string, locale: string): string | null {
  if (!expression.trim()) return null

  try {
    return cronstrue.toString(expression, {
      locale,
      use24HourTimeFormat: true,
      throwExceptionOnParseError: true,
    })
  } catch {
    return null
  }
}

export function cronNextRuns(expression: string, count: number): Date[] {
  if (!expression.trim()) return []

  try {
    return new Cron(expression).nextRuns(count)
  } catch {
    return []
  }
}
