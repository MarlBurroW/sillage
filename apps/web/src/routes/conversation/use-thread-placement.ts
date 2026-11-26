import { useEffect, useLayoutEffect, useState, useRef, type RefObject } from 'react'
import { recordPerformance } from '../../lib/performance-diagnostics'
import { useThreadLayout } from '../../lib/use-thread-layout'

/** Distance within which the user is considered to be following the thread bottom. */
export const STICKY_THRESHOLD_PX = 120

/**
 * Beyond this, journal replay is no longer instant and needs an indicator.
 *
 * Hide the thread while it builds, sufficient for one or two frames. A twenty-thousand-event
 * thread requires roughly forty sequential pages, each cursor derived from the previous page's
 * last `seq`; hiding alone would make the screen look dead. Delay long enough that ordinary
 * conversations open without ever showing it.
 */
const SLOW_REPLAY_MS = 400

/**
 * Scroll the thread all the way down.
 *
 * Calculate the target instead of relying on clamping an oversized `scrollTop`, then reapply
 * next frame: code blocks and images still change thread height after the jump, and targeting
 * an outdated height stops short of the end.
 */
export function scrollToBottom(node: HTMLElement): void {
  node.scrollTop = node.scrollHeight - node.clientHeight
  requestAnimationFrame(() => {
    node.scrollTop = node.scrollHeight - node.clientHeight
  })
}

export interface ThreadPlacement {
  stuckToBottom: boolean
  setStuckToBottom: (stuck: boolean) => void
  lastTop: RefObject<number>
  placed: boolean
  setPlaced: (placed: boolean) => void
  slowReplay: boolean
}

/**
 * Whether the thread is shown yet and whether it follows its bottom.
 *
 * Declared before the window and navigation hooks: its layout effects must keep running first,
 * as they did when everything lived in the page.
 */
export function useThreadPlacement(
  scroller: RefObject<HTMLDivElement | null>,
  conversationId: string | undefined,
): ThreadPlacement {
  const [stuckToBottom, setStuckToBottom] = useState(true)
  /**
   * Position from the last scroll event, used to recognize a reading gesture.
   *
   * Following the bottom cannot rely solely on distance to it: content continues growing after
   * snapping, as code highlights or images load, so the snap event is processed against an
   * already changed height. The thread appeared abandoned, follow mode stopped, and live output
   * continued screens below the reader. Growing height never lowers `scrollTop`, and snapping
   * only raises it: now only an upward gesture detaches the thread.
   */
  const lastTop = useRef(0)
  /**
   * The thread is positioned and ready to show.
   *
   * False throughout journal replay: content is built in batches at a meaningless position, and
   * exposing it would show scaffolding. Also false during conversation switches while the
   * previous thread remains mounted.
   */
  const [placed, setPlaced] = useState(false)
  useThreadLayout(scroller, stuckToBottom, placed)
  /** Replay has lasted long enough for a hidden thread to look like a dead screen. */
  const [slowReplay, setSlowReplay] = useState(false)

  // Before paint, resetting `placed` on a different conversation: the page is not remounted
  // between threads, so the new ID's first render still contains the old thread at its old
  // position, which would briefly appear under the new title.
  useLayoutEffect(() => {
    setPlaced(false)
  }, [conversationId])

  // Arm the indicator only after hiding the thread, and disarm when shown:
  // ordinary conversations never reach the timeout, so nothing flashes
  // between threads.
  useEffect(() => {
    setSlowReplay(false)
    if (placed) return
    const timer = setTimeout(() => setSlowReplay(true), SLOW_REPLAY_MS)
    return () => clearTimeout(timer)
  }, [placed, conversationId])

  useEffect(() => {
    if (placed) recordPerformance('thread-visible')
  }, [placed])

  return { stuckToBottom, setStuckToBottom, lastTop, placed, setPlaced, slowReplay }
}
