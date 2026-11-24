import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../lib/i18n'
import { Button, IconButton } from '../ui'
import { TOUR_START, TOUR_STEPS, type TourAnchor, type TourStep } from './steps'

interface Box {
  top: number
  left: number
  width: number
  height: number
}

/** Room left between the highlighted element and the frame drawn around it. */
const HALO = 6
/** Gap between that frame and the bubble. */
const GAP = 12
const MARGIN = 12

/** The element a step points at, when it is really on screen: rendered, in view, and not inert. */
function anchorOf(id: TourAnchor): HTMLElement | null {
  for (const node of document.querySelectorAll<HTMLElement>(`[data-tour="${id}"]`)) {
    const rect = node.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    // The phone's drawer keeps its content mounted, slid off the left edge.
    if (rect.right <= 0 || rect.left >= window.innerWidth) continue
    if (node.closest('[inert]')) continue
    return node
  }
  return null
}

function boxOf(node: HTMLElement): Box {
  const rect = node.getBoundingClientRect()
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
}

const sameBox = (a: Box | null, b: Box | null) =>
  a === b || (a !== null && b !== null && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height)

/**
 * The bubbles themselves, loaded only when a tour is due: an account sees them once, so their code
 * stays out of the main bundle (see `InterfaceTour`).
 */
export function TourOverlay({ onEnd }: { onEnd: () => void }) {
  const t = useTranslate()
  // The steps on screen when the tour starts; null while waiting for a conversation.
  const [steps, setSteps] = useState<TourStep[] | null>(null)
  const [index, setIndex] = useState(0)
  const [box, setBox] = useState<Box | null>(null)
  const bubble = useRef<HTMLDivElement>(null)
  const [bubbleSize, setBubbleSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    if (steps) return
    const look = () => {
      if (!anchorOf(TOUR_START)) return
      setSteps(TOUR_STEPS.filter((step) => anchorOf(step.id) !== null))
    }
    look()
    const timer = window.setInterval(look, 400)
    return () => window.clearInterval(timer)
  }, [steps])

  const step = steps?.[index]
  const stepId = step?.id
  const last = steps !== null && index === steps.length - 1

  const next = useCallback(() => {
    if (!steps) return
    // Skip what left the screen meanwhile (a page change, a folded column).
    let target = index + 1
    while (target < steps.length && !anchorOf(steps[target]!.id)) target++
    if (target >= steps.length) onEnd()
    else setIndex(target)
  }, [steps, index, onEnd])
  const back = useCallback(() => {
    if (!steps) return
    let target = index - 1
    while (target >= 0 && !anchorOf(steps[target]!.id)) target--
    if (target >= 0) setIndex(target)
  }, [steps, index])

  // Follow the element: layouts settle late, panels resize, the phone's keyboard moves the page.
  useLayoutEffect(() => {
    if (!stepId) return
    anchorOf(stepId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const measure = () => {
      const node = anchorOf(stepId)
      const nextBox = node ? boxOf(node) : null
      setBox((current) => (sameBox(current, nextBox) ? current : nextBox))
    }
    measure()
    const timer = window.setInterval(measure, 250)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [stepId])

  // The bubble's size decides where it fits: follow it as steps and languages change its text.
  useLayoutEffect(() => {
    const node = bubble.current
    if (!node) return
    const measure = () => {
      const size = { width: node.offsetWidth, height: node.offsetHeight }
      setBubbleSize((current) => (current.width === size.width && current.height === size.height ? current : size))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [stepId])

  // Once measured: the bubble stays hidden until it can be placed, and a hidden button takes no focus.
  const placed = bubbleSize.height > 0
  useEffect(() => {
    if (!stepId || !placed) return
    bubble.current?.querySelector<HTMLButtonElement>('[data-tour-next]')?.focus()
  }, [stepId, placed])

  useEffect(() => {
    if (!step) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onEnd()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        next()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        back()
      } else if (event.key === 'Tab') {
        // The page behind is shown, not offered: Tab stays among the bubble's own buttons.
        const buttons = Array.from(bubble.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        if (buttons.length === 0) return
        event.preventDefault()
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
      }
    }
    // Capture: the interface behind has its own shortcuts, which must not fire meanwhile.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [step, next, back, onEnd])

  if (!steps || !step) return null

  const frame = box
    ? { top: box.top - HALO, left: box.left - HALO, width: box.width + HALO * 2, height: box.height + HALO * 2 }
    : null
  const place = bubblePlace(frame, bubbleSize)

  return createPortal(
    <div className="fixed inset-0 z-[90]" data-interface-tour>
      {/* Catches every click: the interface behind is shown, not offered. Focus stays in the bubble. */}
      <div className="absolute inset-0" onMouseDown={(event) => event.preventDefault()} onClick={(event) => event.stopPropagation()} />
      {/* One element makes both the dimming and the hole: its shadow covers everything but itself. */}
      <div
        aria-hidden
        className="pointer-events-none absolute rounded-xl ring-2 ring-accent motion-safe:transition-[top,left,width,height] motion-safe:duration-200"
        style={{ ...(frame ?? { top: '50%', left: '50%', width: 0, height: 0 }), boxShadow: '0 0 0 200vmax rgb(0 0 0 / 0.55)' }}
      />
      <div
        ref={bubble}
        role="dialog"
        aria-modal="true"
        aria-labelledby="interface-tour-title"
        aria-describedby="interface-tour-body"
        data-tour-step={step.id}
        className="surface shadow-float absolute flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2 rounded-xl border border-line p-4 text-ink motion-safe:transition-[top,left] motion-safe:duration-200"
        style={{ top: place.top, left: place.left, visibility: placed ? 'visible' : 'hidden' }}
      >
        <p className="text-xs font-medium text-ink-faint">{t('tour.progress', { step: index + 1, total: steps.length })}</p>
        <h2 id="interface-tour-title" className="text-base font-semibold">{t(step.title)}</h2>
        <p id="interface-tour-body" className="text-sm leading-relaxed text-ink-soft">{t(step.body)}</p>
        {last ? <p className="text-xs text-ink-faint">{t('tour.replay')}</p> : null}
        <div className="mt-1 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onEnd}>{t('tour.skip')}</Button>
          <span className="flex-1" />
          {index > 0 ? (
            <IconButton size="sm" label={t('tour.back')} onClick={back}>
              <ArrowLeft size={15} />
            </IconButton>
          ) : null}
          <Button size="sm" onClick={next} icon={last ? undefined : <ArrowRight size={14} />} data-tour-next>
            {t(last ? 'tour.done' : 'tour.next')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * Beside the element when there is room (the rail and the column sit on the left), otherwise
 * under it, otherwise above; kept inside the window in every case. Without an element, centred.
 */
function bubblePlace(frame: Box | null, size: { width: number; height: number }): { top: number; left: number } {
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  const clampLeft = (left: number) => Math.max(MARGIN, Math.min(left, viewport.width - size.width - MARGIN))
  const clampTop = (top: number) => Math.max(MARGIN, Math.min(top, viewport.height - size.height - MARGIN))
  if (!frame) return { top: clampTop((viewport.height - size.height) / 2), left: clampLeft((viewport.width - size.width) / 2) }

  const right = frame.left + frame.width + GAP
  if (right + size.width + MARGIN <= viewport.width && frame.width < viewport.width / 2) {
    return { top: clampTop(frame.top), left: right }
  }
  const leftSide = frame.left - GAP - size.width
  if (leftSide >= MARGIN && frame.width < viewport.width / 2) return { top: clampTop(frame.top), left: leftSide }
  const below = frame.top + frame.height + GAP
  const centred = clampLeft(frame.left + frame.width / 2 - size.width / 2)
  if (below + size.height + MARGIN <= viewport.height) return { top: below, left: centred }
  const above = frame.top - GAP - size.height
  if (above >= MARGIN) return { top: above, left: centred }
  // Taller than the window allows on either side: over the element's lower part, still readable.
  return { top: clampTop(viewport.height - size.height - MARGIN), left: centred }
}
