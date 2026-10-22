import { TooltipButton } from '../ui/Tooltip'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { findRanges, supportsHighlight } from '../../lib/find-in-page'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

/** Highlight registry names kept in sync with CSS highlight selectors. */
const ALL = 'sg-find'
const CURRENT = 'sg-find-current'

/** Space above targeted occurrences to preserve context. */
const SCROLL_MARGIN_PX = 96

function clearHighlights(): void {
  if (!supportsHighlight()) return
  CSS.highlights.delete(ALL)
  CSS.highlights.delete(CURRENT)
}

/**
 * Search the open conversation client-side because the entire log is already loaded. Custom
 * Highlight API colors ranges without DOM changes that would break Markdown/code. Without support,
 * scrolling and message rings still locate matches.
 */
export function ThreadSearch({
  scroller,
  open,
  onClose,
  /** Changes for every received event, triggering match recomputation. */
  revision,
}: {
  scroller: RefObject<HTMLDivElement | null>
  open: boolean
  onClose: () => void
  revision: number
}) {
  const [query, setQuery] = useState('')
  const [count, setCount] = useState(0)
  const [index, setIndex] = useState(0)
  const ranges = useRef<Range[]>([])
  const input = useRef<HTMLInputElement>(null)
  const t = useTranslate()

  // Ranges belong to thread DOM and cannot survive closing or conversation changes.
  useEffect(() => clearHighlights, [])

  /**
   * Escape closes from anywhere, including next/previous buttons where focus otherwise left the
   * search bar open.
   */
  useEffect(() => {
    if (!open) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (open) input.current?.focus()
    else {
      clearHighlights()
      setQuery('')
      setCount(0)
      setIndex(0)
      ranges.current = []
    }
  }, [open])

  /** Reread matches from the currently displayed thread. */
  const refresh = useCallback((): Range[] => {
    const container = scroller.current
    const found = container ? findRanges(container, query) : []

    ranges.current = found
    setCount(found.length)
    // Retain the current occurrence while valid: turn completion must not jump readers to the first match.
    setIndex((current) => (current < found.length ? current : 0))

    if (supportsHighlight()) {
      if (found.length === 0) clearHighlights()
      else CSS.highlights.set(ALL, new Highlight(...found))
    }

    return found
  }, [query, scroller])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh, revision])

  /** Promote an occurrence and bring it into view. */
  useEffect(() => {
    const container = scroller.current
    if (!open || !container) return

    // Collapsed ranges indicate DOM redraw since searching: browsers reanchor them to parents and
    // lose their location.
    const range = ranges.current[index]?.collapsed ? refresh()[index] : ranges.current[index]
    if (!range) return

    if (supportsHighlight()) CSS.highlights.set(CURRENT, new Highlight(range))

    const target = range.getBoundingClientRect()
    const view = container.getBoundingClientRect()
    if (target.top < view.top + SCROLL_MARGIN_PX || target.bottom > view.bottom) {
      container.scrollBy({ top: target.top - view.top - SCROLL_MARGIN_PX })
    }
  }, [index, count, open, refresh, scroller])

  if (!open) return null

  const step = (direction: 1 | -1) => {
    if (count === 0) return
    setIndex((current) => (current + direction + count) % count)
    // Restore input focus after arrow clicks so further typing continues searching.
    input.current?.focus()
  }

  return (
    <div
      className={cx(
        'surface sticky top-[var(--header-height)] z-10 flex shrink-0 items-center gap-2',
        'border-b border-line px-3 py-1.5',
      )}
    >
      <Search size={15} className="shrink-0 text-ink-faint" />
      <input
        ref={input}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            step(event.shiftKey ? -1 : 1)
          }
        }}
        placeholder={t('thread.search.placeholder')}
        className="h-8 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
      />

      <span className="shrink-0 text-xs text-ink-faint tabular-nums">
        {query.trim() === ''
          ? ''
          : count === 0
            ? t('thread.search.noResults')
            : t('thread.search.position', { index: index + 1, count })}
      </span>

      <TooltipButton
        type="button"
        onClick={() => step(-1)}
        disabled={count === 0}
        aria-label={t('thread.search.previous')}
        className="flex size-7 shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink disabled:opacity-40"
      >
        <ChevronUp size={15} />
      </TooltipButton>
      <TooltipButton
        type="button"
        onClick={() => step(1)}
        disabled={count === 0}
        aria-label={t('thread.search.next')}
        className="flex size-7 shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink disabled:opacity-40"
      >
        <ChevronDown size={15} />
      </TooltipButton>
      <TooltipButton
        type="button"
        onClick={onClose}
        aria-label={t('thread.search.close')}
        className="flex size-7 shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink"
      >
        <X size={15} />
      </TooltipButton>
    </div>
  )
}
