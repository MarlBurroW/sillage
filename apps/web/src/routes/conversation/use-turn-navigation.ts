import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { ChatRow } from '../../lib/tool-rows'
import type { TurnMarker } from '../../lib/turns'

/** Must cover the `sg-flash-turn` animation, otherwise the ring cuts off abruptly. */
const FLASH_DURATION_MS = 1500

export interface TurnNavigation {
  /** Each turn's position in the thread, populated from user messages. */
  turnAnchors: RefObject<Map<string, HTMLElement>>
  visibleTurns: Set<string>
  /** Last turn reached by a jump, highlighted briefly for orientation. */
  flashed: string | null
  setFlashed: (id: string | null) => void
  syncVisibleTurns: () => void
  jumpToTurn: (id: string) => void
  step: (direction: -1 | 1) => void
}

/** The turn ruler: which turns are on screen, jumps to a turn, and previous/next arrows. */
export function useTurnNavigation({
  scroller,
  turns,
  view,
  reveal,
  scrollAnchor,
  items,
  lastSeq,
}: {
  scroller: RefObject<HTMLDivElement | null>
  turns: TurnMarker[]
  view: { rows: ChatRow[]; hidden: number }
  reveal: (itemId: string) => boolean
  scrollAnchor: RefObject<{ height: number; top: number } | null>
  /** Thread content and progress: their change may move turns, and the ruler follows them. */
  items: unknown
  lastSeq: number
}): TurnNavigation {
  /** Each turn's position in the thread, populated from user messages. */
  const turnAnchors = useRef(new Map<string, HTMLElement>())
  const [visibleTurns, setVisibleTurns] = useState<Set<string>>(() => new Set())
  /** Last turn reached by a jump, highlighted briefly for orientation. */
  const [flashed, setFlashed] = useState<string | null>(null)
  /** Target turn not yet mounted: jump once it is mounted. */
  const pendingJump = useRef<string | null>(null)

  /**
   * Turns whose regions intersect the viewport. A turn spans from its user message to the next,
   * keeping long turns highlighted while reading anywhere within them.
   */
  const syncVisibleTurns = useCallback(() => {
    const node = scroller.current
    if (!node) return

    const top = node.scrollTop
    const bottom = top + node.clientHeight

    const anchors = [...turnAnchors.current.entries()]
      .map(([id, element]) => ({ id, top: element.offsetTop }))
      .sort((a, b) => a.top - b.top)

    const next = new Set<string>()
    anchors.forEach((anchor, index) => {
      const end = anchors[index + 1]?.top ?? node.scrollHeight
      if (end > top && anchor.top < bottom) next.add(anchor.id)
    })

    // A new set on every scroll event would continuously redraw the ruler:
    // replace state only when it actually changes.
    setVisibleTurns((current) =>
      current.size === next.size && [...next].every((id) => current.has(id)) ? current : next,
    )
  }, [scroller])

  const jumpToTurn = useCallback(
    (id: string) => {
      const node = scroller.current
      if (!node) return

      const anchor = turnAnchors.current.get(id)
      // The ruler lists all turns, including those before the window: mount them, then
      // resume the jump from the layout effect once the anchor exists.
      if (!anchor) {
        if (reveal(id)) pendingJump.current = id
        return
      }

      // `scrollTo`, not `scrollIntoView`: the latter also scrolls parent containers,
      // including the entire page on mobile.
      node.scrollTo({ top: anchor.offsetTop - 12, behavior: 'smooth' })
      // In dense threads, landing without knowing where is little better than not moving:
      // highlight the destination message.
      setFlashed(id)
    },
    [reveal, scroller],
  )

  // Delay jumps until the target turn mounts, and reposition after expansion.
  // Both scroll corrections must precede paint; otherwise the thread visibly
  // starts in the wrong place then corrects itself.
  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return

    const jump = pendingJump.current
    if (jump) {
      const anchor = turnAnchors.current.get(jump)
      if (!anchor) return
      pendingJump.current = null
      // No animation: the turn just appeared, and sliding from a position that did not
      // exist at click time conveys nothing useful.
      node.scrollTo({ top: anchor.offsetTop - 12 })
      setFlashed(jump)
      return
    }

    const saved = scrollAnchor.current
    if (!saved) return
    scrollAnchor.current = null
    node.scrollTop = saved.top + (node.scrollHeight - saved.height)
  }, [view.rows, scroller, scrollAnchor])

  // The ring clears itself; otherwise it would remain on a long-abandoned message
  // and stop meaning “you just arrived here”.
  useEffect(() => {
    if (!flashed) return
    const timer = setTimeout(() => setFlashed(null), FLASH_DURATION_MS)
    return () => clearTimeout(timer)
  }, [flashed])

  /**
   * Next or previous turn from the scroll position.
   *
   * Deliberately not from `visibleTurns`: after a jump, the preceding turn remains visible
   * because its region extends to the next message. Taking the first visible turn repeatedly
   * returned to the same place, preventing the next arrow from descending.
   *
   * Reread anchors on every call: they move as content grows, so cached positions would be
   * stale by the next turn.
   */
  const step = useCallback(
    (direction: -1 | 1) => {
      const node = scroller.current
      if (!node) return

      const anchors = [...turnAnchors.current.entries()]
        .map(([id, element]) => ({ id, top: element.offsetTop }))
        .sort((a, b) => a.top - b.top)

      // Tolerance: jumps land at `offsetTop - 12`, and smooth scrolling stops a few
      // pixels away. Without it, the just-reached turn appears “below” itself,
      // leaving the arrow stuck in place.
      const cursor = node.scrollTop + 16
      const target =
        direction === 1
          ? anchors.find((anchor) => anchor.top > cursor)
          : [...anchors].reverse().find((anchor) => anchor.top < cursor - 8)

      if (target) {
        jumpToTurn(target.id)
        return
      }

      // Nothing mounted above, but the thread continues before the window:
      // without this fallback, the arrow would stop at the first displayed turn
      // as if the conversation began there.
      if (direction === -1 && view.hidden > 0) {
        const first = anchors[0]
        const index = first ? turns.findIndex((turn) => turn.id === first.id) : turns.length
        const previous = turns[index - 1]
        if (previous) jumpToTurn(previous.id)
      }
    },
    [jumpToTurn, turns, view.hidden, scroller],
  )

  // Growing content moves turns: the ruler must follow even without
  // user scrolling.
  useEffect(syncVisibleTurns, [syncVisibleTurns, items, lastSeq])

  return { turnAnchors, visibleTurns, flashed, setFlashed, syncVisibleTurns, jumpToTurn, step }
}
