import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ChatStream } from '../../lib/use-chat-stream'
import type { ChatRow } from '../../lib/tool-rows'
import {
  INITIAL_WINDOW_ROWS,
  WINDOW_STEP_ROWS,
  windowRows,
  windowToReveal,
  type ThreadWindow,
} from '../../lib/thread-window'

export interface ThreadWindowState {
  view: ThreadWindow
  /** Thread position before expansion, restored after inserting earlier content. */
  scrollAnchor: RefObject<{ height: number; top: number } | null>
  reveal: (itemId: string) => boolean
  showEarlier: () => void
  growWindowTo: (seq: number) => boolean
}

/** Which rows of the thread are mounted, and how earlier ones are brought in. See `thread-window`. */
export function useThreadWindow({
  conversationId,
  rows,
  findOpen,
  stream,
  scroller,
}: {
  conversationId: string | undefined
  rows: ChatRow[]
  findOpen: boolean
  stream: ChatStream
  scroller: RefObject<HTMLDivElement | null>
}): ThreadWindowState {
  const { loadOlder } = stream
  const currentThread = useRef(conversationId)
  currentThread.current = conversationId

  /** Mounted row count, from the end. See `thread-window`. */
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW_ROWS)
  /** Thread position before expansion, restored after inserting earlier content. */
  const scrollAnchor = useRef<{ height: number; top: number } | null>(null)

  // A different conversation starts from the end; otherwise it would open with as
  // many expanded rows as the previous one, unrelated to its own length.
  useLayoutEffect(() => {
    setWindowSize(INITIAL_WINDOW_ROWS)
  }, [conversationId])

  useEffect(() => {
    if (findOpen && stream.hasMore && !stream.loadingOlder && !stream.error && !stream.loading) void loadOlder()
  }, [findOpen, stream.hasMore, stream.loadingOlder, stream.error, stream.loading, loadOlder, stream.state.items])

  const view = useMemo(
    // Thread search traverses the DOM: windowing would search truncated content and
    // report too few matches. Keep everything mounted while search
    // is open.
    () => windowRows(rows, findOpen ? Number.POSITIVE_INFINITY : windowSize),
    [rows, windowSize, findOpen],
  )

  /** Mount a row preceding the window. False if absent from the thread. */
  const reveal = useCallback(
    (itemId: string) => {
      const needed = windowToReveal(rows, itemId)
      if (needed === null) return false
      setWindowSize((size) => Math.max(size, needed))
      return true
    },
    [rows],
  )

  const showEarlier = useCallback(() => {
    const expand = () => {
      if (currentThread.current !== conversationId) return
      const node = scroller.current
      if (node) scrollAnchor.current = { height: node.scrollHeight, top: node.scrollTop }
      setWindowSize((size) => size + WINDOW_STEP_ROWS)
    }
    if (view.hidden === 0 && stream.hasMore) void loadOlder().then(expand)
    else expand()
  }, [view.hidden, stream.hasMore, loadOlder, conversationId, scroller])

  /**
   * Mount a message before the window by its `seq`.
   *
   * Return true while a page request or window expansion will produce another render. Both
   * opening paths keep the thread hidden until the requested message can be positioned.
   */
  const growWindowTo = useCallback(
    (seq: number): boolean => {
      const target = stream.state.items.find(
        (item) => item.kind === 'message' && item.seq === seq,
      )
      if (!target) {
        if (stream.hasMore && !stream.error) {
          if (!stream.loadingOlder) void loadOlder()
          return true
        }
        return false
      }
      const needed = windowToReveal(rows, target.id)
      if (needed === null || needed <= windowSize) return false
      setWindowSize(needed)
      return true
    },
    [stream.state.items, rows, windowSize, stream.hasMore, stream.error, stream.loadingOlder, loadOlder],
  )

  return { view, scrollAnchor, reveal, showEarlier, growWindowTo }
}
