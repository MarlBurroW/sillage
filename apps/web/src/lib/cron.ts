import { Cron } from 'croner'
import cronstrue from 'cronstrue/i18n'

/**
 * Readable cron description and next occurrences. A bare `45 4 * * *` input hides typos until the
 * next day's missing run. A sentence and the next three dates make the pattern verifiable while
 * typing. Compute in the browser for immediate preview without round trips; dates therefore use
 * device time rather than server time, explicitly stated in the UI.
 */

/** Null for invalid patterns, also serving as validity checking. */
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
