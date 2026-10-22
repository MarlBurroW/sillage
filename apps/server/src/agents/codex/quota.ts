/**
 * Quota-window labels from CLI data. Compact for thread badges, long for usage panels. One
 * implementation prevents the silent divergence previously caused by duplicated formatting.
 */
export function describeWindow(
  limitName: string | null,
  durationMins: number | null,
  compact = false,
): string {
  if (limitName) return limitName
  if (durationMins === null) return 'quota'
  if (durationMins < 60) return `${durationMins} min`
  const hours = durationMins / 60
  // 168 hours is hard to read: express durations beyond one day in days.
  if (hours >= 24 && hours % 24 === 0) {
    return compact ? `${hours / 24} j` : `${hours / 24} jours`
  }
  return compact ? `${Math.round(hours)} h` : `${Math.round(hours)} heures`
}
