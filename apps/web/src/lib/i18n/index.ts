import { useCallback, useSyncExternalStore } from 'react'
import { catalogFor, isCatalogLoaded, loadCatalog, LOCALES, type Locale } from './catalogs'
import type { MessageKey } from './catalog-en'

export { LOCALES, LOCALE_LABELS, type Locale } from './catalogs'
export type { MessageKey } from './catalog-en'

/**
 * UI text translation. Use a typed catalog rather than a library: Sillage has only two languages,
 * and compiler checks are stronger than runtime checks here. Unknown keys and missing translations
 * fail compilation, whereas i18next would silently accept `t('typo')` until display. Language lives
 * in the browser rather than the database: no migration and immediate switching, at the accepted
 * cost of selecting it per device.
 */

const STORAGE_KEY = 'sillage.locale'

/** Fallback when the system language is unsupported or a key is missing. */
const FALLBACK: Locale = 'en'

function isLocale(value: string | null): value is Locale {
  return value !== null && (LOCALES as readonly string[]).includes(value)
}

/**
 * Language on first load: saved choice, otherwise browser language. `navigator.language` returns
 * fr-FR or en-US: keep only the language subtag so regional variants match.
 */
function detect(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (isLocale(stored)) return stored
  const language = navigator.language.split('-')[0] ?? ''
  return isLocale(language) ? language : FALLBACK
}

/*
 * Start in English, the only eagerly available catalog, then let `initLocale()` switch to the
 * detected language after loading its catalog. `current` never names a language whose text is
 * missing, so raw keys cannot appear.
 */
let current: Locale = FALLBACK
/** Requested language whose catalog is loading, for pending state. */
let pending: Locale | null = null
/** Latest request: a more recent click wins over a slower load. */
let requested: Locale = FALLBACK
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function apply(next: Locale): void {
  current = next
  // `lang` controls hyphenation, speech synthesis, and browser spellchecking: keeping the previous
  // value would apply English rules to French text.
  document.documentElement.lang = next
}

/**
 * Current language, directly usable as an `Intl` locale: both catalog codes are recognized, so
 * dates and numbers use `toLocaleString(locale())` without a mapping table. Dates need no separate
 * subscription: `useTranslate()` already subscribes the component and its rerender reformats them.
 */
export function locale(): Locale {
  return current
}

/**
 * Load the selected catalog before the first render. Rendering first would briefly flash English
 * while downloading. Failure (offline without precache, missing chunk after deployment) does not
 * prevent startup: keep English and preserve the saved choice for next load. Loading starts on
 * module import below; this function always returns the same promise. `main.tsx` awaits it, while
 * components mounted independently (Playwright harnesses, previews) switch through `notify` when it
 * arrives.
 */
export function initLocale(): Promise<void> {
  initial ??= loadInitial()
  return initial
}

let initial: Promise<void> | null = null

async function loadInitial(): Promise<void> {
  const wanted = detect()
  requested = wanted
  try {
    await loadCatalog(wanted)
    if (requested === wanted && current !== wanted) {
      apply(wanted)
      notify()
    }
  } catch (error) {
    console.warn(`Catalogue « ${wanted} » indisponible, interface en anglais.`, error)
    if (requested === wanted) apply(FALLBACK)
  }
}

/**
 * Change language. Load the catalog before switching so the UI moves between complete languages
 * without intermediate English or raw keys. `usePendingLocale()` exposes the wait.
 */
export async function setLocale(next: Locale): Promise<void> {
  requested = next
  if (next === current) {
    if (pending !== null) {
      pending = null
      notify()
    }
    return
  }
  if (!isCatalogLoaded(next)) {
    pending = next
    notify()
    try {
      await loadCatalog(next)
    } catch (error) {
      // Save nothing: keep the UI consistently in the previous language.
      if (requested === next) {
        pending = null
        notify()
      }
      throw error
    }
    // A newer choice was made during loading; it takes precedence.
    if (requested !== next) return
  }
  pending = null
  localStorage.setItem(STORAGE_KEY, next)
  apply(next)
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Substitution values. Numbers pass through `String` without formatting: format display numbers
 * with `Intl` before passing them here.
 */
export type MessageParams = Record<string, string | number>

function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    // Leave missing parameter markers intact rather than writing undefined: visible during review
    // and avoids inventing a misleading sentence.
    name in params ? String(params[name]) : whole,
  )
}

/**
 * Translate a key in the current language outside React. Inside components prefer `useTranslate()`,
 * which rerenders on language changes. This reads the current value without subscribing.
 */
export function translate(key: MessageKey, params?: MessageParams): string {
  const catalog = catalogFor(current)
  return interpolate(catalog[key] ?? catalogFor(FALLBACK)[key], params)
}

/**
 * Translation subscribed to the current language: changing it rerenders users without a context
 * provider. The function deliberately changes identity with language. Returning stable `translate`
 * would leave `useMemo(..., [t])` unchanged and freeze memoized labels in the previous language. A
 * changing identity makes `[t]` sufficient and hook dependency rules accurate.
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
 * Translate a server error by code. The server does not know the user's language: it sends a code,
 * interpolation values, and an English message, which serves as fallback here. The code is a
 * runtime string rather than a `MessageKey`, so compilation cannot guarantee catalog presence. A
 * new server code without a matching key would otherwise display a raw identifier; fallback
 * preserves an accurate, untranslated sentence.
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

/** Current language for components displaying or changing the setting. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, locale, () => FALLBACK)
}

function pendingLocale(): Locale | null {
  return pending
}

/** Language catalog still loading after a selection, otherwise `null`. */
export function usePendingLocale(): Locale | null {
  return useSyncExternalStore(subscribe, pendingLocale, () => null)
}

// Skip under Node: server tests import the translating thread fold.
if (typeof document !== 'undefined') void initLocale()
