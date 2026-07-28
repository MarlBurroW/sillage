import { useCallback, useSyncExternalStore } from 'react'
import { catalogFor, LOCALES, type Locale } from './catalogs'
import type { MessageKey } from './catalog-en'

export { LOCALES, LOCALE_LABELS, type Locale } from './catalogs'
export type { MessageKey } from './catalog-en'

/**
 * Traduction des textes de l'interface.
 *
 * Un catalogue typé plutôt qu'une bibliothèque : Sillage n'a que deux langues, et le
 * compilateur est ici un meilleur garde-fou qu'un runtime. Une clé inconnue ne compile
 * pas, une traduction oubliée non plus, alors qu'un `t('typo')` passerait en silence
 * avec i18next et n'apparaîtrait qu'à l'écran.
 *
 * La langue vit dans le navigateur, pas en base : rien à migrer, et le choix est
 * immédiat. Il est donc à refaire sur chaque appareil, ce qui est le prix assumé.
 */

const STORAGE_KEY = 'sillage.locale'

/** Repli quand la langue du système n'est pas couverte, et quand une clé manque. */
const FALLBACK: Locale = 'en'

function isLocale(value: string | null): value is Locale {
  return value !== null && (LOCALES as readonly string[]).includes(value)
}

/**
 * Langue au premier chargement : celle qu'on a retenue, sinon celle du navigateur.
 *
 * `navigator.language` vaut « fr-FR » ou « en-US » : on ne garde que la sous-étiquette
 * de langue, sans quoi aucun réglage régional ne correspondrait jamais.
 */
function detect(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (isLocale(stored)) return stored
  const language = navigator.language.split('-')[0] ?? ''
  return isLocale(language) ? language : FALLBACK
}

let current: Locale = detect()
const listeners = new Set<() => void>()

/**
 * Langue courante, utilisable telle quelle comme étiquette `Intl` : les deux catalogues
 * portent des codes qu'`Intl` connaît, donc les dates et les nombres se formatent avec
 * `toLocaleString(locale())` sans table de correspondance.
 *
 * Aucun abonnement séparé n'est nécessaire pour les dates : `useTranslate()` abonne déjà
 * le composant, et un rendu qu'il déclenche les reformate au passage.
 */
export function locale(): Locale {
  return current
}

export function setLocale(next: Locale): void {
  if (next === current) return
  current = next
  localStorage.setItem(STORAGE_KEY, next)
  // `lang` sert à la césure, à la synthèse vocale et aux correcteurs du navigateur :
  // laisser l'ancienne valeur ferait lire du français avec des règles anglaises.
  document.documentElement.lang = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Valeurs substituables. Les nombres passent par `String` sans mise en forme :
 *  un nombre à afficher se formate avec `Intl` avant d'arriver ici. */
export type MessageParams = Record<string, string | number>

function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    // Un paramètre absent laisse son marqueur en place plutôt que d'écrire « undefined » :
    // c'est visible en relecture, et ça ne fabrique pas une phrase fausse.
    name in params ? String(params[name]) : whole,
  )
}

/**
 * Traduit une clé dans la langue courante.
 *
 * Hors composant React : à l'intérieur, préférer `useTranslate()`, qui redéclenche le
 * rendu au changement de langue. Celle-ci lit la valeur du moment et ne s'abonne à rien.
 */
export function translate(key: MessageKey, params?: MessageParams): string {
  const catalog = catalogFor(current)
  return interpolate(catalog[key] ?? catalogFor(FALLBACK)[key], params)
}

/**
 * Traduction abonnée à la langue courante : changer de langue rerend tout ce qui
 * l'utilise, sans avoir à faire remonter la valeur dans un contexte.
 *
 * L'identité de la fonction change avec la langue, et c'est délibéré. Renvoyer
 * `translate` telle quelle serait plus simple mais piégeux : sa référence étant stable,
 * un `useMemo(..., [t])` ne se recalculerait jamais au changement de langue, et les
 * libellés mémoïsés resteraient figés dans l'ancienne. Avec une identité qui bouge,
 * `[t]` suffit, et la règle des dépendances de hooks dit la vérité.
 */
export function useTranslate(): (key: MessageKey, params?: MessageParams) => string {
  const active = useSyncExternalStore(subscribe, locale, () => FALLBACK)
  return useCallback(
    (key: MessageKey, params?: MessageParams) => {
      const catalog = catalogFor(active)
      return interpolate(catalog[key] ?? catalogFor(FALLBACK)[key], params)
    },
    [active],
  )
}

/**
 * Traduit une erreur du serveur à partir de son code.
 *
 * Le serveur ne connaît pas la langue de l'utilisateur : il envoie un code, ce que la
 * phrase interpole, et un message anglais. La traduction se fait donc ici, et le message
 * du serveur sert de repli.
 *
 * Ce repli n'est pas une politesse. Le code est une chaîne d'exécution, pas une
 * `MessageKey` : rien ne garantit à la compilation qu'il soit au catalogue, et un code
 * ajouté côté serveur sans sa clé afficherait sinon un identifiant brut. Avec le repli,
 * il affiche une phrase juste, seulement pas traduite.
 */
export function translateError(
  code: string,
  message: string,
  params?: MessageParams,
): string {
  const key = `error.${code}`
  const catalog = catalogFor(current)
  const template = catalog[key as MessageKey] ?? catalogFor(FALLBACK)[key as MessageKey]
  return template ? interpolate(template, params) : interpolate(message, params)
}

/** Langue courante, pour les composants qui affichent ou changent le réglage. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, locale, () => FALLBACK)
}
