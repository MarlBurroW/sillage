import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import type { HighlightRange } from '../../lib/composer-highlights'

/**
 * Marks attached resources behind the composer's textarea.
 *
 * A textarea cannot style part of its text, and replacing it with an editable div would cost the
 * caret, selection, dictation, IME and mobile keyboard behaviour it gets for free. So this layer
 * repeats the text underneath, with the same font, padding and wrapping, transparent, and paints
 * a tint under each resolved span. The text above keeps its colour and weight: changing either
 * would move glyphs and leave the caret out of place.
 */
export function ComposerHighlights({ text, ranges, textarea, className }: {
  text: string
  ranges: HighlightRange[]
  textarea: RefObject<HTMLTextAreaElement | null>
  /** Same font, padding and line height as the textarea. */
  className: string
}) {
  const layer = useRef<HTMLDivElement>(null)

  // Follow the textarea's box (its scrollbar narrows the text) and its scroll position.
  useLayoutEffect(() => {
    const area = textarea.current
    const mirror = layer.current
    if (!area || !mirror) return
    const sync = () => {
      mirror.style.width = `${area.clientWidth}px`
      mirror.style.height = `${area.clientHeight}px`
      mirror.scrollTop = area.scrollTop
    }
    sync()
    area.addEventListener('scroll', sync)
    const resize = new ResizeObserver(sync)
    resize.observe(area)
    return () => {
      area.removeEventListener('scroll', sync)
      resize.disconnect()
    }
  }, [textarea, text, ranges.length])

  if (ranges.length === 0) return null
  const parts: ReactNode[] = []
  let at = 0
  for (const range of ranges) {
    if (range.start > at) parts.push(text.slice(at, range.start))
    parts.push(<mark key={range.start} data-kind={range.kind} className="rounded-sm bg-accent-wash text-transparent ring-1 ring-inset ring-accent/30 [box-decoration-break:clone]">{text.slice(range.start, range.end)}</mark>)
    at = range.end
  }
  // A trailing newline only takes room when something follows it.
  parts.push(`${text.slice(at)}​`)

  return (
    <div ref={layer} aria-hidden
      className={`pointer-events-none absolute left-0 top-0 overflow-hidden whitespace-pre-wrap break-words text-transparent ${className}`}>
      {parts}
    </div>
  )
}
