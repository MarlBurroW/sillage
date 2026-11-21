import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/**
 * Lazy chunks of an older build disappear from the server at each deployment, and a tab left open
 * then fails to load them: the error reached no boundary and the page went blank. Reloading fetches
 * the current build. A guard in session storage keeps a missing chunk on the new build from turning
 * into a reload loop: the second failure within a minute is left to the error boundary.
 */
const GUARD_KEY = 'sillage.chunk-reload'
const GUARD_MS = 60_000

function reloadedRecently(): boolean {
  try {
    const last = Number(sessionStorage.getItem(GUARD_KEY))
    return Number.isFinite(last) && Date.now() - last < GUARD_MS
  } catch {
    return false
  }
}

/** Asks the service worker for the current build, then reloads. */
export async function reloadForUpdate(): Promise<void> {
  try {
    sessionStorage.setItem(GUARD_KEY, String(Date.now()))
  } catch {
    // Storage refused (private mode): reloading still helps.
  }
  try {
    await (await navigator.serviceWorker?.getRegistration())?.update()
  } catch {
    // No service worker, or offline: the reload alone fetches what the server has.
  }
  window.location.reload()
}

/** `React.lazy` that reloads once when the chunk is gone, instead of throwing into a blank page. */
// Same constraint as `React.lazy`, whose components accept any props.
export function lazyWithReload<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      return await load()
    } catch (err) {
      if (reloadedRecently()) throw err
      await reloadForUpdate()
      // The page is going away; keep React waiting rather than flashing the error.
      return new Promise<{ default: T }>(() => {})
    }
  })
}

/** Vite reports a failed preload of a module's dependencies here, outside any component. */
export function reloadOnPreloadError(): void {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadedRecently()) return
    event.preventDefault()
    void reloadForUpdate()
  })
}
