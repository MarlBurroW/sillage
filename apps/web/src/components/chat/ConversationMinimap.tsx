import { useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { TurnMarker } from '../../lib/turns'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

/**
 * Turn rail left of the thread: one marker per exchange, highlighting visible turns and previewing
 * both messages on hover. Locates position in long conversations without blind scrolling. Space
 * markers uniformly rather than by content height because short and long turns are equally
 * meaningful navigation targets. When height is insufficient, use a sliding window around current
 * position rather than shrinking markers into unusable targets. Keep spacing constant and scroll
 * content instead.
 */
/** Vertical marker spacing. */
const TICK_PITCH_PX = 15

/** Below this capacity the window conveys no location; slight overflow is preferable. */
const MIN_WINDOW = 8

export function ConversationMinimap({
  turns,
  visibleIds,
  agentLabel,
  onJump,
}: {
  turns: TurnMarker[]
  visibleIds: Set<string>
  agentLabel: string
  onJump: (id: string) => void
}) {
  const t = useTranslate()
  const nav = useRef<HTMLElement>(null)
  const [capacity, setCapacity] = useState(0)

  // Nav height follows turn count and CSS cap, never derived capacity, preventing measurement feedback loops.
  useLayoutEffect(() => {
    const node = nav.current
    if (!node) return

    const observer = new ResizeObserver(([entry]) => {
      // Entry arrays may be empty by type even though only one node is observed, so direct access
      // fails compilation.
      if (!entry) return
      setCapacity(Math.max(MIN_WINDOW, Math.floor(entry.contentRect.height / TICK_PITCH_PX)))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // Retain across renders: between scroll synchronizations no turn is visible and the window would
  // jump to the beginning.
  const lastStart = useRef(0)

  const start = useMemo(() => {
    if (capacity <= 0 || turns.length <= capacity) return 0

    let first = -1
    let last = -1
    turns.forEach((turn, index) => {
      if (!visibleIds.has(turn.id)) return
      if (first < 0) first = index
      last = index
    })

    const max = turns.length - capacity
    if (first < 0) return Math.min(lastStart.current, max)

    const centered = Math.round((first + last) / 2 - capacity / 2)
    const next = Math.max(0, Math.min(centered, max))
    lastStart.current = next
    return next
  }, [capacity, turns, visibleIds])

  // A lone turn needs no rail.
  if (turns.length < 2) return null

  const end = capacity > 0 ? Math.min(start + capacity, turns.length) : turns.length
  const shown = turns.slice(start, end)

  return (
    <nav
      ref={nav}
      aria-label={t('minimap.nav.label')}
      className={cx(
        'pointer-events-none absolute top-1/2 left-5 z-10 hidden -translate-y-1/2',
        // Match the thread's reserved gutter breakpoint so the rail never overlaps text.
        '@min-[40rem]:flex',
      )}
      /**
       * Height follows turn count up to available space, keeping constant spacing. Fixed height
       * spread markers further apart on larger screens.
       */
      style={{ height: `min(90%, ${turns.length * TICK_PITCH_PX}px)` }}
    >
      <ul className="pointer-events-auto flex h-full flex-col justify-between">
        {shown.map((turn, index) => {
          const visible = visibleIds.has(turn.id)
          // Fade edge markers where the conversation continues to distinguish sliding windows from complete rails.
          const faded =
            (start > 0 && index < 2) || (end < turns.length && index >= shown.length - 2)

          return (
            <li key={turn.id} className="group/tick relative flex min-h-0 shrink items-center">
              <button
                type="button"
                onClick={() => onJump(turn.id)}
                aria-label={turn.user || t('minimap.turn.untitled')}
                className="flex h-3 w-6 items-center justify-start"
              >
                <span
                  className={cx(
                    'h-0.5 rounded-full transition-all',
                    visible ? 'w-4 bg-ink-soft' : 'w-3 bg-line-strong group-hover/tick:bg-ink-faint',
                    faded && !visible ? 'opacity-40' : null,
                  )}
                />
              </button>

              {/* Pure-CSS tooltip: JavaScript positioning would recalculate on every live delta. */}
              <div
                className={cx(
                  'invisible absolute top-1/2 left-full z-20 ml-1 w-72 -translate-y-1/2 opacity-0',
                  'surface rounded-lg border border-line p-2.5 shadow-pop transition-opacity',
                  'group-hover/tick:visible group-hover/tick:opacity-100',
                  // Use focus-visible rather than focus-within: mouse clicks retain button focus
                  // and would leave tooltips open after navigation.
                  'group-has-[:focus-visible]/tick:visible group-has-[:focus-visible]/tick:opacity-100',
                )}
              >
                <p className="text-[0.6875rem] font-semibold tracking-wide text-ink-faint uppercase">
                  {t('minimap.turn.you')}
                </p>
                <p className="mt-0.5 text-xs text-ink">{turn.user || t('minimap.turn.attachmentOnly')}</p>

                {turn.assistant ? (
                  <>
                    <p className="mt-2 text-[0.6875rem] font-semibold tracking-wide text-ink-faint uppercase">
                      {agentLabel}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-soft">{turn.assistant}</p>
                  </>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
