import { MessageSquare } from 'lucide-react'
import { useEffect, useRef, useState, type FocusEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import type { CardDto } from '@sillage/protocol'
import { cardHref } from '../../lib/card-refs'
import { useTranslate } from '../../lib/i18n'
import { COLUMN_DOTS, columnLabel } from './columns'
import { GitHubMark } from './GitHubMark'

/** Hover delay prevents passing pointers opening previews. */
const HOVER_DELAY_MS = 250
const WIDTH_PX = 320
/** Estimated preview height to decide whether it fits below the reference. */
const ROOM_PX = 220
const EXCERPT_CHARS = 240

interface Shown {
  card: CardDto
  rect: DOMRect
}

/** Reference button beneath an event and its card number. */
function referenceOf(target: EventTarget | null): { element: HTMLElement; number: number } | null {
  const element = target instanceof Element ? target.closest<HTMLElement>('[data-sg-card]') : null
  const number = Number(element?.dataset.sgCard)
  return element && Number.isInteger(number) ? { element, number } : null
}

/**
 * Rendered # references open cards on click and preview column/title/description on hover or focus.
 * Delegate through the container because markdown-it injects HTML without per-reference React
 * components. Portaled previews ignore pointers: read them, then click the reference to navigate.
 */
export function useCardRefPreview(projectId: string | null, cards: Map<number, CardDto>) {
  const navigate = useNavigate()
  const [shown, setShown] = useState<Shown | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const show = (target: EventTarget | null, delay: number) => {
    const reference = referenceOf(target)
    const card = reference ? cards.get(reference.number) : undefined
    if (!reference || !card) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setShown({ card, rect: reference.element.getBoundingClientRect() }), delay)
  }
  const hide = (target: EventTarget | null, next: EventTarget | null) => {
    const reference = referenceOf(target)
    // Moving from the button to its own text is not leaving it.
    if (!reference || (next instanceof Node && reference.element.contains(next))) return
    if (timer.current) clearTimeout(timer.current)
    setShown(null)
  }

  const handlers = {
    onMouseOver: (event: MouseEvent) => show(event.target, HOVER_DELAY_MS),
    onMouseOut: (event: MouseEvent) => hide(event.target, event.relatedTarget),
    onFocus: (event: FocusEvent) => show(event.target, 0),
    onBlur: (event: FocusEvent) => hide(event.target, event.relatedTarget),
    onClickCapture: (event: MouseEvent) => {
      const reference = referenceOf(event.target)
      if (!reference || !projectId || !cards.has(reference.number)) return
      event.preventDefault()
      event.stopPropagation()
      setShown(null)
      const href = cardHref(projectId, reference.number)
      // Ctrl/Command opens a new tab like a link without leaving the thread.
      if (event.metaKey || event.ctrlKey) window.open(href, '_blank', 'noopener')
      else navigate(href)
    },
  }

  return { handlers, preview: shown ? <CardPreview shown={shown} /> : null }
}

function CardPreview({ shown }: { shown: Shown }) {
  const t = useTranslate()
  const { card, rect } = shown
  const excerpt = card.description.trim().replace(/\s+/g, ' ')
  const issue = card.external && !card.external.detached ? card.external : null
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH_PX - 8))
  const below = rect.bottom + ROOM_PX < window.innerHeight
  const position = below ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }

  return createPortal(
    <div
      role="tooltip"
      style={{ left, width: WIDTH_PX, ...position }}
      className="surface pointer-events-none fixed z-50 flex flex-col gap-2 rounded-lg border border-line p-3 text-left shadow-pop"
    >
      <div className="flex items-center gap-2 text-[0.6875rem] text-ink-faint">
        <span className={`size-2 shrink-0 rounded-full ${COLUMN_DOTS[card.column]}`} />
        <span>{columnLabel(card.column)}</span>
        <span className="ml-auto font-medium">#{card.number}</span>
      </div>
      <p className="text-sm font-semibold leading-snug text-ink">{card.title}</p>
      {excerpt ? (
        <p className="line-clamp-4 text-xs leading-relaxed text-ink-soft">
          {excerpt.length > EXCERPT_CHARS ? `${excerpt.slice(0, EXCERPT_CHARS)}…` : excerpt}
        </p>
      ) : null}
      {card.conversations.length > 0 || issue ? (
        <div className="flex items-center gap-3 text-[0.6875rem] text-ink-faint">
          {card.conversations.length > 0 ? (
            <span className="inline-flex items-center gap-1">
              <MessageSquare size={11} />
              {t('board.card.sessions', { count: card.conversations.length })}
            </span>
          ) : null}
          {issue ? (
            <span className="inline-flex items-center gap-1">
              <GitHubMark size={11} />
              {issue.number}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>,
    document.body,
  )
}
