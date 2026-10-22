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

/** Narrow list label; full localized dates remain available in session details. */
export function compactRelativeDate(ts: number): string {
  const minutes = Math.max(1, Math.floor((Date.now() - ts) / 60_000))
  const [value, unit]: [number, string] = minutes < 60 ? [minutes, 'minute'] : minutes < 1440
    ? [Math.floor(minutes / 60), 'hour'] : [Math.floor(minutes / 1440), 'day']
  return new Intl.NumberFormat(locale(), { style: 'unit', unit, unitDisplay: 'narrow' }).format(value)
}
