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

/** How long to wait for a new service worker to install and take control before reloading anyway. */
const TAKEOVER_MS = 8_000

/**
 * Hands control to a newer service worker. With `registerType: 'prompt'` a new worker stays
 * waiting while this page is open, and a plain reload keeps the page overlapping, so the old
 * worker served the old bundle again: an old build crashing on new server data stayed broken
 * after "Reload" until a hard refresh.
 */
async function activateNewerWorker(registration: ServiceWorkerRegistration): Promise<void> {
  const sw = navigator.serviceWorker
  if (!sw.controller) return
  const installing = registration.installing
  if (installing && !registration.waiting) {
    await new Promise<void>((resolve) => {
      const done = () => {
        if (installing.state === 'installed' || installing.state === 'redundant' || installing.state === 'activated') resolve()
      }
      installing.addEventListener('statechange', done)
      done()
    })
  }
  const waiting = registration.waiting
  if (!waiting) return
  const takenOver = new Promise<void>((resolve) => sw.addEventListener('controllerchange', () => resolve(), { once: true }))
  // Same message the vite-plugin-pwa prompt flow sends; the generated worker answers with skipWaiting().
  waiting.postMessage({ type: 'SKIP_WAITING' })
  await takenOver
}

/** Asks the service worker for the current build, lets it take over, then reloads. */
export async function reloadForUpdate(): Promise<void> {
  try {
    sessionStorage.setItem(GUARD_KEY, String(Date.now()))
  } catch {
    // Storage refused (private mode): reloading still helps.
  }
  try {
    const registration = await navigator.serviceWorker?.getRegistration()
    if (registration) {
      await registration.update()
      await Promise.race([activateNewerWorker(registration), new Promise((resolve) => setTimeout(resolve, TAKEOVER_MS))])
    }
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
