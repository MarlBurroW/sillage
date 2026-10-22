import { useEffect, useRef, useState, type RefObject } from 'react'
import { RefreshCw } from 'lucide-react'
import { cx } from './ui'

/** Damped indicator travel required to refresh. */
const THRESHOLD_PX = 64
/** Maximum indicator downward travel. */
const MAX_PULL_PX = 88
/** Finger travel doubles indicator travel, matching native gestures. */
const RESISTANCE = 0.5
/** Below this threshold touch jitter implies no gesture yet. */
const SLOP_PX = 6
/** Indicator size, initially hidden above the edge. */
const BADGE_PX = 36

/**
 * Pull-to-refresh within scrollable areas. Installed PWAs lack browser refresh and Sillage
 * documents never scroll (index.css), so phones otherwise had no gesture. Register listeners
 * manually because React touchmove is passive; active listeners must prevent native scrolling or
 * iOS bounces the list while the indicator descends.
 */
function usePull(target: RefObject<HTMLElement | null>, onRefresh: () => void): number {
  const [distance, setDistance] = useState(0)
  // Use a ref so listeners mounted once invoke the current callback.
  const refreshRef = useRef(onRefresh)
  refreshRef.current = onRefresh

  useEffect(() => {
    const node = target.current
    if (!node) return

    let origin: { x: number; y: number } | null = null
    let pulling = false
    let pulled = 0

    const reset = () => {
      origin = null
      pulling = false
      pulled = 0
      setDistance(0)
    }

    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0]
      origin = event.touches.length === 1 && touch && !scrolledAway(event.target, node)
        ? { x: touch.clientX, y: touch.clientY }
        : null
    }

    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!origin || !touch) return
      // Long-press already started row dragging and owns scrolling: leave it the gesture.
      if (event.defaultPrevented) {
        reset()
        return
      }

      const dx = touch.clientX - origin.x
      const dy = touch.clientY - origin.y
      if (!pulling) {
        // Upward motion scrolls: return to browser control until the next touch.
        if (dy < 0) {
          origin = null
          return
        }
        // Capture from the first pixel because iOS decides scrolling at initial movement and
        // disallows cancellation later.
        if (event.cancelable) event.preventDefault()
        if (Math.hypot(dx, dy) < SLOP_PX) return
        if (Math.abs(dx) > dy) {
          origin = null
          return
        }
        pulling = true
      }

      if (event.cancelable) event.preventDefault()
      pulled = Math.min(MAX_PULL_PX, Math.max(0, dy) * RESISTANCE)
      setDistance(pulled)
    }

    const onEnd = () => {
      if (pulling && pulled >= THRESHOLD_PX) refreshRef.current()
      reset()
    }

    node.addEventListener('touchstart', onStart, { passive: true })
    node.addEventListener('touchmove', onMove, { passive: false })
    node.addEventListener('touchend', onEnd)
    node.addEventListener('touchcancel', reset)
    return () => {
      node.removeEventListener('touchstart', onStart)
      node.removeEventListener('touchmove', onMove)
      node.removeEventListener('touchend', onEnd)
      node.removeEventListener('touchcancel', reset)
    }
  }, [target])

  return distance
}

/** Whether any scrollable ancestor between touch and container is below its top. */
function scrolledAway(target: EventTarget | null, container: HTMLElement): boolean {
  for (let node = target instanceof Element ? target : null; node; node = node.parentElement) {
    if (node.scrollTop > 0) return true
    if (node === container) return false
  }
  return false
}

/**
 * Indicator follows the finger then spins during refresh. Place in the positioned observed
 * container, overlaying its top without shifting or rerendering list contents during the gesture.
 */
export function PullToRefresh({ target, refreshing, onRefresh }: {
  target: RefObject<HTMLElement | null>
  refreshing: boolean
  onRefresh: () => void
}) {
  const distance = usePull(target, onRefresh)
  const offset = refreshing ? THRESHOLD_PX : distance
  const armed = refreshing || distance >= THRESHOLD_PX

  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-28 justify-center overflow-hidden">
      <span
        className={cx(
          'surface flex items-center justify-center rounded-full border border-line shadow-float',
          // Follow fingers immediately; animate only after release.
          distance > 0 && !refreshing ? null : 'transition-[translate,opacity] duration-200 ease-out',
        )}
        style={{
          width: BADGE_PX,
          height: BADGE_PX,
          translate: `0 ${offset - BADGE_PX}px`,
          opacity: offset > 0 ? 1 : 0,
        }}
      >
        <RefreshCw
          size={16}
          className={cx(armed ? 'text-accent' : 'text-ink-faint', refreshing && 'animate-spin')}
          style={refreshing ? undefined : { rotate: `${distance * 3}deg` }}
        />
      </span>
    </div>
  )
}
