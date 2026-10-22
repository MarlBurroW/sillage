import { locale } from './i18n'

/**
 * Timestamp age in the UI language. Compute here rather than with Git: `%cr` uses server language
 * and freezes at query time, while commit lists can remain visible for a long time.
 */
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 30],
  ['month', 12],
  ['year', Infinity],
]

export function relativeDate(ts: number): string {
  const format = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' })

  let value = (ts - Date.now()) / 1000
  for (const [unit, size] of UNITS) {
    if (Math.abs(value) < size) return format.format(Math.round(value), unit)
    value /= size
  }
  return format.format(Math.round(value), 'year')
}
