import { useCallback, useEffect, useSyncExternalStore } from 'react'

/**
 * Actually visible height published as `--sg-app-height`. On mobile the keyboard shrinks the visual
 * viewport without changing the layout viewport: `100dvh` still spans the full screen and hides the
 * composer under the keyboard. Only `visualViewport` tracks the keyboard. Write a CSS variable
 * rather than React state: keyboard animations emit dozens of events, and rerendering the app for
 * each would slow the conversation thread.
 */
/**
 * Keyboard height above the resting gap required for recognition. Low enough to catch every
 * keyboard and independent of the constant non-editing gap some platforms report, which is measured
 * separately.
 */
const KEYBOARD_MIN_PX = 80

/**
 * Gap between viewport and screen bottoms published as `--sg-viewport-gap`. An installed iOS app
 * shifts the viewport up by the status-bar height and anchors it at the top: 894 px of viewport for
 * a 956 px screen leaves 62 px unreachable at the bottom. The home indicator already lies within
 * that gap: adding `env(safe-area-inset-bottom)` would pay for it twice and waste phone space.
 * Measure the gap and subtract it from the inset. Only in installed mode: ordinary browsers report
 * the same gap with expanded toolbars, where subtraction would put content underneath. Assumes
 * portrait orientation, already enforced by the manifest.
 */
function publishViewportGap(root: HTMLElement): void {
  if (!matchMedia('(display-mode: standalone)').matches) return
  const gap = Math.max(0, screen.height - window.innerHeight)
  root.style.setProperty('--sg-viewport-gap', `${gap}px`)
}

export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const root = document.documentElement
    publishViewportGap(root)

    /**
     * Gap between viewports without a keyboard. Installed PWAs report a constant nonzero gap even
     * with no keyboard open. A fixed threshold could be exceeded by a device's actual gap,
     * permanently forcing visual-viewport height and leaving an empty strip beneath the composer.
     * The smallest observed gap corresponds to a closed keyboard, so measure rather than guess. A
     * minimum only decreases and corrects itself if initially measured at the wrong moment.
     */
    let resting = Number.POSITIVE_INFINITY

    const clear = () => {
      root.style.removeProperty('--sg-app-height')
      root.style.removeProperty('--sg-viewport-top')
      /*
       * Closing the keyboard can leave the visual viewport offset inside the layout viewport:
       * installed iPadOS does not always reset it or emit `resize`/`scroll`. The fixed layer
       * redraws correctly, but WebKit retains old touch regions until the next scroll, leaving the
       * composer and thread bottom unresponsive. Resetting document scroll realigns both viewports
       * and forces hit-region recalculation. With no offset, this is a no-op.
       */
      window.scrollTo(0, 0)
    }

    const hasInputFocus = () => document.activeElement instanceof HTMLElement
      && document.activeElement.matches('input, textarea, [contenteditable]:not([contenteditable="false"])')

    const apply = () => {
      // `innerHeight` may follow the keyboard on iOS, while the fixed layer remains sized by the layout viewport.
      const gap = Math.max(0, Math.max(root.clientHeight, window.innerHeight) - viewport.height)
      // Mounting or rotating during text entry must not record keyboard height as the resting gap.
      // Closing the keyboard refines the measurement.
      if (!hasInputFocus() && gap < resting) resting = gap
      const baseline = Number.isFinite(resting) ? resting : 0

      // Only a keyboard warrants forcing height: otherwise remove the measurement and let CSS take over.
      if (gap - baseline < KEYBOARD_MIN_PX) {
        clear()
        return
      }

      root.style.setProperty('--sg-app-height', `${viewport.height}px`)
      // iOS also scrolls the page behind the keyboard: compensate for this offset or the header
      // leaves the top of the screen.
      root.style.setProperty('--sg-viewport-top', `${viewport.offsetTop}px`)
    }

    // Rotation changes the resting gap: reset its measurement, or the previous smaller gap could
    // make the new one look like a keyboard.
    const remeasure = () => {
      resting = Number.POSITIVE_INFINITY
      publishViewportGap(root)
      apply()
    }

    /*
     * Fallback for keyboard closure without a viewport event (see `clear`): when input loses focus
     * without another input gaining it, repeat measurement after the keyboard animation delay. If
     * `resize` fired meanwhile, `apply` already restored everything and this changes nothing.
     */
    let settle: ReturnType<typeof setTimeout> | undefined
    const onFocusOut = () => {
      clearTimeout(settle)
      settle = setTimeout(() => {
        if (hasInputFocus()) return
        apply()
        // `apply` does nothing if the keyboard was not recognized: document realignment must still happen.
        window.scrollTo(0, 0)
      }, 350)
    }

    apply()
    viewport.addEventListener('resize', apply)
    viewport.addEventListener('scroll', apply)
    window.addEventListener('orientationchange', remeasure)
    document.addEventListener('focusout', onFocusOut)

    return () => {
      clearTimeout(settle)
      viewport.removeEventListener('resize', apply)
      viewport.removeEventListener('scroll', apply)
      window.removeEventListener('orientationchange', remeasure)
      document.removeEventListener('focusout', onFocusOut)
      root.style.removeProperty('--sg-viewport-gap')
      clear()
    }
  }, [])
}

/**
 * Track a media query. Needed where a `hidden` class is insufficient: CSS-hidden elements remain
 * mounted, and mounted redirects still execute. Settings use this because their list occupies the
 * whole page on touch screens and a column elsewhere.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    // There is no server rendering here, but `useSyncExternalStore` requires a snapshot.
    () => false,
  )
}
