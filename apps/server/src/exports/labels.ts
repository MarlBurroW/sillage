import { exportEn } from '../../../web/src/lib/i18n/export-en.js'
import { exportFr } from '../../../web/src/lib/i18n/export-fr.js'

/** These pure catalog fragments are shared with the UI, without importing browser state. */
export function exportText(locale: 'en' | 'fr') {
  const catalog = locale === 'fr' ? exportFr : exportEn
  return (key: keyof typeof exportEn): string => catalog[key]
}
