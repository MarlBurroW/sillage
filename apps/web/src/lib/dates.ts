import { locale } from './i18n'

/**
 * Ancienneté d'un horodatage, dans la langue de l'interface.
 *
 * Calculée ici et non par git : `%cr` sort dans la langue du serveur, qui n'est pas
 * celle du lecteur, et se fige au moment de la requête alors qu'une liste de commits
 * reste affichée longtemps.
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
