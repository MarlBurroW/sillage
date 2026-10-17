import { en, type Catalog } from './catalog-en'

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

/**
 * Catalogues autres que l'anglais, chargés à la demande.
 *
 * Une seule langue sert à la fois : embarquer toutes les autres dans le paquet principal
 * le faisait dépasser la limite de précache de Workbox pour du texte jamais affiché.
 * L'anglais reste importé statiquement, parce qu'il fait foi pour les types et sert de
 * repli quand une clé manque ou qu'un chargement échoue : il doit être là sans attendre.
 *
 * Chaque `import()` devient un chunk à part, que le service worker précache comme le
 * reste (`globPatterns`) : le changement de langue marche aussi hors ligne.
 */
const LOADERS: Record<Exclude<Locale, 'en'>, () => Promise<Catalog>> = {
  fr: () => import('./catalog-fr').then((module) => module.fr),
}

const loaded: Partial<Record<Locale, Catalog>> = { en }
const inflight = new Map<Locale, Promise<Catalog>>()

/** Catalogue déjà chargé, ou l'anglais s'il ne l'est pas encore. Jamais d'attente. */
export function catalogFor(value: Locale): Catalog {
  return loaded[value] ?? en
}

export function isCatalogLoaded(value: Locale): boolean {
  return loaded[value] !== undefined
}

/**
 * Charge le catalogue d'une langue, une seule fois.
 *
 * La promesse en cours est partagée : deux clics rapprochés ne téléchargent pas deux
 * fois. Un échec n'est pas mémorisé, pour qu'un nouvel essai (retour du réseau) reparte.
 */
export function loadCatalog(value: Locale): Promise<Catalog> {
  const ready = loaded[value]
  if (ready) return Promise.resolve(ready)
  const pending = inflight.get(value)
  if (pending) return pending
  const promise = LOADERS[value as Exclude<Locale, 'en'>]()
    .then((catalog) => {
      loaded[value] = catalog
      return catalog
    })
    .finally(() => inflight.delete(value))
  inflight.set(value, promise)
  return promise
}
