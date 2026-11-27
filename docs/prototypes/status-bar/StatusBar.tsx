import * as Dialog from '@radix-ui/react-dialog'
import { ChevronRight, SlidersHorizontal, X } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Tooltip } from '../../../apps/web/src/components/ui/Tooltip'
import { IconButton, Popover, cx } from '../../../apps/web/src/components/ui'
import type { Entry } from './data'
import { piecesOf, type Piece, type RenderContext } from './items'

const GAP = 12
const MORE_WIDTH = 30
const CONFIGURE_WIDTH = 30

/**
 * The status line under the composer: one line at every width. Pieces show in the user's order
 * while they fit; the rest goes behind "+N". The shortcut reminder sits at the far right and is
 * the first to go.
 */
export function StatusBar({ entries, context, onConfigure, onOpen }: {
  entries: Entry[]
  context: RenderContext
  onConfigure: () => void
  onOpen: (place: string) => void
}) {
  const pieces = entries.flatMap((entry) => piecesOf(entry, context))
  const ordered = [...pieces.filter((piece) => !piece.end), ...pieces.filter((piece) => piece.end)]
  const row = useRef<HTMLDivElement>(null)
  const ruler = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(ordered.length)
  const [sheet, setSheet] = useState(false)
  const [more, setMore] = useState(false)
  const compact = context.compact

  // Measure every render: the turn clock and scenario switches change widths.
  useLayoutEffect(() => {
    const measure = () => {
      if (!row.current || !ruler.current) return
      const widths = Array.from(ruler.current.children, (child) => (child as HTMLElement).offsetWidth)
      const available = row.current.clientWidth - (compact ? 0 : CONFIGURE_WIDTH)
      const total = widths.reduce((sum, width, index) => sum + width + (index ? GAP : 0), 0)
      let count = widths.length
      if (total > available) {
        let used = 0
        count = 0
        for (const [index, width] of widths.entries()) {
          const next = used + width + (index ? GAP : 0)
          if (next + GAP + MORE_WIDTH > available) break
          used = next
          count += 1
        }
      }
      setFit((current) => (current === count ? current : count))
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (row.current) observer.observe(row.current)
    return () => observer.disconnect()
  })

  const shown = ordered.slice(0, fit)
  // A reminder that does not fit just goes: it is not information worth a "+N".
  const hidden = ordered.slice(fit).filter((item) => !item.end)
  const main = shown.filter((piece) => !piece.end)
  const tail = shown.filter((piece) => piece.end)

  const piece = (item: Piece) => compact ? (
    <span key={item.id} className="flex shrink-0 items-center">{item.node}</span>
  ) : (
    <Tooltip key={item.id} label={<span className="whitespace-pre-line">{item.detail}</span>}>
      <button type="button" onClick={() => item.opens && onOpen(item.opens)}
        className={cx('flex shrink-0 items-center rounded-sm hover:text-ink focus-visible:outline-2 focus-visible:outline-accent', item.end && 'ml-auto', !item.opens && 'cursor-default')}>
        {item.node}
      </button>
    </Tooltip>
  )

  const moreBadge = hidden.length > 0 ? (
    <span className="shrink-0 rounded border border-line px-1 leading-4 text-ink-soft">+{hidden.length}</span>
  ) : null

  // `pt-1` + `min-h-7` rows: the same box as the shortcuts button beside it (`mt-1 min-h-7`), so
  // both centre on one line.
  return (
    <div className="relative min-w-0 px-1.5 pt-1 text-[0.6875rem] text-ink-faint" data-status-bar>
      {/* Invisible copy at natural width, to decide how many pieces fit. */}
      <div ref={ruler} aria-hidden className="pointer-events-none invisible absolute top-0 left-0 flex gap-3 whitespace-nowrap">
        {ordered.map((item) => <span key={item.id} className="flex shrink-0 items-center">{item.node}</span>)}
      </div>

      {compact ? (
        // Phone: the whole line is one target that opens the full list.
        <button ref={row as React.RefObject<HTMLButtonElement & HTMLDivElement>} type="button" onClick={() => setSheet(true)}
          aria-label="Infos de la session"
          className="flex min-h-7 w-full min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap rounded-sm text-left">
          {main.map(piece)}
          {moreBadge}
        </button>
      ) : (
        <div ref={row} className="flex min-h-7 min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap">
          {main.map(piece)}
          {hidden.length > 0 ? (
            <Popover open={more} onOpenChange={setMore} label="Autres infos de la session" side="top" align="end"
              trigger={<button type="button" className="shrink-0 rounded-sm hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">{moreBadge}</button>}>
              <div className="w-80 overflow-y-auto p-1">
                <PieceList pieces={hidden} onOpen={(place) => { setMore(false); onOpen(place) }} />
              </div>
            </Popover>
          ) : null}
          {tail.map(piece)}
          <span className={cx('flex shrink-0', tail.length === 0 && 'ml-auto')}>
            <IconButton label="Personnaliser la barre d’état" size="sm" onClick={onConfigure}>
              <SlidersHorizontal size={12} />
            </IconButton>
          </span>
        </div>
      )}

      <Dialog.Root open={sheet} onOpenChange={setSheet}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
          <Dialog.Content aria-describedby={undefined}
            className="surface fixed inset-x-0 bottom-0 z-50 flex max-h-[80dvh] flex-col rounded-t-xl border-t border-line shadow-pop">
            <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
              <Dialog.Title className="flex-1 text-sm font-semibold">Infos de la session</Dialog.Title>
              <Dialog.Close asChild><IconButton label="Fermer"><X size={18} /></IconButton></Dialog.Close>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {/* Everything, not only what overflowed: the line is a summary, this is the full view. */}
              <PieceList pieces={ordered} onOpen={(place) => { setSheet(false); onOpen(place) }} />
            </div>
            <footer className="shrink-0 border-t border-line p-2 pb-[max(0.5rem,var(--sg-safe-bottom))]">
              <button type="button" onClick={() => { setSheet(false); onConfigure() }}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-md text-sm text-ink-soft hover:bg-surface-high hover:text-ink">
                <SlidersHorizontal size={15} />Personnaliser la barre
              </button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

function PieceList({ pieces, onOpen }: { pieces: Piece[]; onOpen: (place: string) => void }) {
  return (
    <ul className="flex flex-col">
      {pieces.map((piece) => {
        const body = (
          <>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center justify-between gap-3 text-sm">
                <span className="text-ink-soft">{piece.name}</span>
                <span className="shrink-0 text-ink">{piece.value}</span>
              </span>
              <span className="whitespace-pre-line text-xs leading-relaxed text-ink-faint">{piece.detail}</span>
            </span>
            {piece.opens ? <ChevronRight size={15} className="shrink-0 text-ink-faint" /> : <span className="w-[15px] shrink-0" />}
          </>
        )
        return (
          <li key={piece.id}>
            {piece.opens ? (
              <button type="button" onClick={() => onOpen(piece.opens!)}
                className="flex min-h-11 w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-surface-high focus-visible:outline-2 focus-visible:outline-accent">
                {body}
              </button>
            ) : <div className="flex min-h-11 items-center gap-2 px-2.5 py-2">{body}</div>}
          </li>
        )
      })}
    </ul>
  )
}
