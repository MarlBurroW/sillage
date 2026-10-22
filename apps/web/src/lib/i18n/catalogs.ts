import { en, type Catalog } from './catalog-en'

/**
 * Available languages with native labels. Separate from index.ts so adding languages touches only
 * this list and catalogs, not the engine. Native labels stay untranslated so users can find their
 * own language even in another-language UI.
 */
export const LOCALE_LABELS = {
  en: 'English',
  fr: 'Français',
} as const

export type Locale = keyof typeof LOCALE_LABELS

export const LOCALES = Object.keys(LOCALE_LABELS) as readonly Locale[]

/**
 * Non-English catalogs loaded on demand. Only one language is active: including every catalog in
 * the main bundle exceeded Workbox's precache limit for never-displayed text. English stays
 * statically imported because it defines types and provides immediate fallback for missing keys or
 * failed loads. Each `import()` creates a separate chunk precached through `globPatterns`,
 * preserving offline language switching.
 */
const LOADERS: Record<Exclude<Locale, 'en'>, () => Promise<Catalog>> = {
  fr: () => import('./catalog-fr').then((module) => module.fr),
}

const loaded: Partial<Record<Locale, Catalog>> = { en }
const inflight = new Map<Locale, Promise<Catalog>>()

/** Loaded catalog or English if not yet available. Never waits. */
export function catalogFor(value: Locale): Catalog {
  return loaded[value] ?? en
}

export function isCatalogLoaded(value: Locale): boolean {
  return loaded[value] !== undefined
}

/**
 * Load a language catalog once. Share pending promises so nearby clicks do not download twice. Do
 * not cache failures so retrying after network recovery works.
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
