import type { MessageKey } from './i18n'

/**
 * Translation keys of the effort levels the CLIs share. Kept apart from `agents.ts` so pure
 * presentation code (tool rows) can name a level without pulling in the query client.
 */
export const EFFORT_KEYS: Record<string, MessageKey> = {
  none: 'effort.level.none',
  minimal: 'effort.level.minimal',
  low: 'effort.level.low',
  medium: 'effort.level.medium',
  high: 'effort.level.high',
  xhigh: 'effort.level.xhigh',
  max: 'effort.level.max',
}
