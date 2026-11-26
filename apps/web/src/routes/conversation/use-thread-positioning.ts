import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ConversationDto } from '@sillage/protocol'
import type { ChatStream } from '../../lib/use-chat-stream'
import { readThreadScroll, saveThreadScroll } from '../../lib/thread-scroll'
import { STICKY_THRESHOLD_PX, scrollToBottom, type ThreadPlacement } from './use-thread-placement'

/**
 * Where the thread opens and how it follows its bottom afterwards: a search result, the saved
 * reading position or the end; then reader gestures, live output and the mobile keyboard.
 */
export function useThreadPositioning({
  scroller,
  conversationId,
  conversation,
  stream,
  placement,
  growWindowTo,
  syncVisibleTurns,
  setFlashed,
}: {
  scroller: RefObject<HTMLDivElement | null>
  conversationId: string | undefined
  conversation: ConversationDto | undefined
  stream: ChatStream
  placement: ThreadPlacement
  growWindowTo: (seq: number) => boolean
  syncVisibleTurns: () => void
  setFlashed: (id: string | null) => void
}): { onScroll: () => void } {
  const { stuckToBottom, setStuckToBottom, lastTop, placed, setPlaced } = placement
  const visibilityFrame = useRef<number | null>(null)

  /** Message targeted by a search result, once the thread loads. */
  const [searchParams] = useSearchParams()
  const anchorSeq = Number(searchParams.get('seq'))
  const hasAnchor = Number.isInteger(anchorSeq) && anchorSeq > 0
  const anchored = useRef<number | null>(null)

  /**
   * Remember the reading position to reopen where the user left off.
   *
   * Use the topmost displayed message: elements follow document order, so the last whose top
   * passed above the edge is the current message. None above means the reader precedes the
   * first message, which then suffices.
   */
  const rememberScroll = useCallback(
    (node: HTMLElement) => {
      if (!conversationId) return

      const top = node.scrollTop
      if (node.scrollHeight - top - node.clientHeight < STICKY_THRESHOLD_PX) {
        saveThreadScroll(conversationId, { atBottom: true, seq: 0, offset: 0 })
        return
      }

      let anchor: HTMLElement | null = null
      for (const element of node.querySelectorAll<HTMLElement>('[data-seq]')) {
        if (anchor && element.offsetTop > top) break
        anchor = element
      }
      if (!anchor) return

      const seq = Number(anchor.dataset.seq)
      if (!Number.isInteger(seq)) return
      saveThreadScroll(conversationId, { atBottom: false, seq, offset: anchor.offsetTop - top })
    },
    [conversationId],
  )

  const onScroll = useCallback(() => {
    const node = scroller.current
    // While the thread builds, heights change with each folded batch and snapping
    // is reapplied. Resulting scroll events say nothing about reader intent;
    // treating them as intentional detached the thread from its bottom
    // before it even appeared.
    if (!node || !placed) return

    // One-pixel tolerance: mobile scrolling is fractional, and rounding noise during
    // downward momentum would otherwise look like upward movement.
    const top = node.scrollTop
    const wentUp = top < lastTop.current - 1
    lastTop.current = top

    // The bottom takes precedence: it also applies when content shrinks and the browser
    // clamps `scrollTop`, moving the position upwards without user scrolling.
    if (node.scrollHeight - top - node.clientHeight < STICKY_THRESHOLD_PX) setStuckToBottom(true)
    else if (wentUp) setStuckToBottom(false)

    if (visibilityFrame.current !== null) return
    visibilityFrame.current = requestAnimationFrame(() => {
      visibilityFrame.current = null
      syncVisibleTurns()
      rememberScroll(node)
    })
  }, [syncVisibleTurns, rememberScroll, placed, scroller, lastTop, setStuckToBottom])

  /**
   * Open at a specific message when arriving from search.
   *
   * Fetch earlier pages and expand the rendering window until the message is mounted. Once per target
   * only, otherwise every received event would reset scrolling for the session's remainder.
   */
  useLayoutEffect(() => {
    const node = scroller.current
    // Depend on `conversation` for the same reason as positioning below: it determines
    // whether the thread is mounted and has a measurable node.
    if (stream.loading || !conversation || !node) return
    if (!hasAnchor || anchored.current === anchorSeq) return
    if (growWindowTo(anchorSeq)) return

    // No more pages can supply this target; do not hide the thread forever if it is absent.
    anchored.current = anchorSeq

    const element = node.querySelector<HTMLElement>(`[data-seq="${anchorSeq}"]`)
    if (!element) return

    node.scrollTo({ top: element.offsetTop - 12 })
    const target = stream.state.items.find(
      (item) => item.kind === 'message' && item.seq === anchorSeq,
    )
    if (target) setFlashed(target.id)
  }, [anchorSeq, hasAnchor, stream.loading, stream.state.items, conversation, growWindowTo, scroller, setFlashed])

  /**
   * Position the thread on opening, then reveal it.
   *
   * Once per conversation after the initial view and any pages needed for the saved anchor
   * arrive. Until then, `placed` keeps the changing layout hidden.
   */
  useLayoutEffect(() => {
    const node = scroller.current
    // The conversation, not just its ID: the thread renders only after metadata arrives.
    // If folding finishes first, this effect has no node to measure and would not
    // rerun when the thread mounts.
    if (placed || stream.loading || !conversationId || !conversation || !node) return

    /**
     * Set the opening position, with `null` meaning bottom, then reveal.
     *
     * Derive bottom-following from the result rather than intent: an old position can end up at
     * the bottom of a barely grown thread; marking it detached would show a bottom arrow while
     * already there.
     */
    const settle = (top: number | null) => {
      if (top === null) scrollToBottom(node)
      else node.scrollTop = top
      // `onScroll` does not track position before placement: without this assignment,
      // the first reading gesture would be compared with another conversation's
      // position and fail to detach the thread.
      lastTop.current = node.scrollTop
      setStuckToBottom(node.scrollHeight - node.scrollTop - node.clientHeight < STICKY_THRESHOLD_PX)
      setPlaced(true)
    }

    // Search takes precedence: opening from a result must show that result, not a
    // previous reading position. The effect above positioned it; only derive
    // bottom-following and reveal it now.
    if (hasAnchor) {
      if (anchored.current === anchorSeq) settle(node.scrollTop)
      return
    }

    const saved = readThreadScroll(conversationId)
    if (saved.atBottom) {
      settle(null)
      return
    }

    // The remembered message may precede the window: bring it in, then resume
    // positioning on the next render while still hidden.
    if (growWindowTo(saved.seq)) return

    const element = node.querySelector<HTMLElement>(`[data-seq="${saved.seq}"]`)
    // No longer in the thread: compacted, forked or deleted. Bottom remains the right default.
    settle(element ? element.offsetTop - saved.offset : null)
  }, [placed, stream.loading, conversationId, conversation, hasAnchor, anchorSeq, growWindowTo, scroller, lastTop, setStuckToBottom, setPlaced])

  // Scroll before paint; otherwise every delta causes a visible jump.
  //
  // Do nothing before placement: this effect follows positioning in the same batch
  // with stale `stuckToBottom`, which would send the freshly restored reading
  // position back to the bottom.
  useLayoutEffect(() => {
    if (!placed || !stuckToBottom) return
    const node = scroller.current
    if (node) scrollToBottom(node)
  }, [stream.state.items, stream.state.lastSeq, stuckToBottom, placed, scroller])

  // Opening the keyboard shrinks the thread viewport: without realignment, the latest
  // message is hidden just when the user replies.
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const stick = () => {
      const node = scroller.current
      if (stuckToBottom && node) scrollToBottom(node)
    }
    viewport.addEventListener('resize', stick)
    return () => viewport.removeEventListener('resize', stick)
  }, [stuckToBottom, scroller])

  return { onScroll }
}
