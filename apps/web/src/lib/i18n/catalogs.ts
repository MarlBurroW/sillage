import { en, type Catalog } from './catalog-en'
import { fr } from './catalog-fr'

/**
 * Langues disponibles, et leur libellé dans leur propre langue.
 *
 * Un fichier à part plutôt que dans `index.ts` : ajouter une langue se fait ici et dans
 * son catalogue, sans toucher au moteur. Le libellé n'est pas traduit, et c'est
 * volontaire — on cherche « Français » dans un sélecteur même quand l'interface est en
 * anglais.
 */
export const LOCALE_LABELS = {
  en: 'English',
  fr: 'Français',
} as const

export type Locale = keyof typeof LOCALE_LABELS

export const LOCALES = Object.keys(LOCALE_LABELS) as readonly Locale[]

const CATALOGS: Record<Locale, Catalog> = { en, fr }

export function catalogFor(value: Locale): Catalog {
  return CATALOGS[value]
}
