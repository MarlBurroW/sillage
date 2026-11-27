import * as Dialog from '@radix-ui/react-dialog'
import { ChevronRight, SlidersHorizontal, X } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Tooltip } from '../../ui/Tooltip'
import { IconButton, Popover, cx } from '../../ui'
import { useLocale, useTranslate } from '../../../lib/i18n'
import type { StatusData } from '../../../lib/status-data'
import type { StatusItem } from '../../../lib/status-bar'
import { useMediaQuery } from '../../../lib/viewport'
import { statusPieces, type StatusPiece, type StatusPlace } from './pieces'

/** Matches `gap-3` between pieces. */
const GAP = 12
/** Room kept for "+N" and for the settings button, measured once rendered. */
const MORE_WIDTH = 32
const CONFIGURE_WIDTH = 32

/**
 * The status line under the composer, in place of the old fixed row. One line at every width:
 * pieces show in the account's order while they fit, the rest goes behind "+N". The shortcut
 * reminder keeps the far right and is the first to go, without counting in "+N": it is a hint,
 * not information.
 *
 * With a mouse, a piece shows its detail on hover and opens where it comes from. On touch
 * screens, where hover does not exist, the whole line opens the full list instead.
 */
export function StatusBar({ items, data, onConfigure, onOpen, preview = false }: {
  items: StatusItem[]
  data: StatusData
  onConfigure: () => void
  onOpen: (place: StatusPlace) => void
  /** Settings preview: same rendering, nothing to open. */
  preview?: boolean
}) {
  const t = useTranslate()
  const locale = useLocale()
  const compact = useMediaQuery('(max-width: 639px)')
  const touch = !useMediaQuery('(hover: hover) and (pointer: fine)')
  const pieces = items.flatMap((item) => statusPieces(item, data, { compact, t, locale }))
  const ordered = [...pieces.filter((piece) => !piece.end), ...pieces.filter((piece) => piece.end)]
  const row = useRef<HTMLDivElement>(null)
  const ruler = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(ordered.length)
  const [sheet, setSheet] = useState(false)
  const [more, setMore] = useState(false)
  const inlineConfigure = !touch && !preview

  // Measured on every render: the turn clock, agents and quotas change widths as they move.
  useLayoutEffect(() => {
    const measure = () => {
      if (!row.current || !ruler.current) return
      const widths = Array.from(ruler.current.children, (child) => (child as HTMLElement).offsetWidth)
      const available = row.current.clientWidth - (inlineConfigure ? CONFIGURE_WIDTH : 0)
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
  const hidden = ordered.slice(fit).filter((piece) => !piece.end)
  const main = shown.filter((piece) => !piece.end)
  const tail = shown.filter((piece) => piece.end)
  const open = (place: StatusPlace | undefined) => { if (place && !preview) onOpen(place) }

  const inline = (piece: StatusPiece) => (touch || preview) ? (
    <span key={piece.id} className={cx('flex shrink-0 items-center', piece.end && 'ml-auto')}>{piece.node}</span>
  ) : (
    <Tooltip key={piece.id} label={<span className="whitespace-pre-line">{piece.detail}</span>}>
      <button type="button" onClick={() => open(piece.opens)}
        className={cx(
          'flex shrink-0 items-center rounded-sm focus-visible:outline-2 focus-visible:outline-accent',
          piece.opens ? 'hover:text-ink' : 'cursor-default',
          piece.end && 'ml-auto',
        )}>
        {piece.node}
      </button>
    </Tooltip>
  )
  const moreBadge = hidden.length > 0 ? (
    <span aria-hidden className="shrink-0 rounded border border-line px-1 leading-4 text-ink-soft">+{hidden.length}</span>
  ) : null

  return (
    // `pt-1` and `min-h-7`: the box of the shortcuts trigger beside it (`mt-1 min-h-7`), so both
    // centre on the same line.
    <div className="relative min-w-0 px-1.5 pt-1 text-[0.6875rem] text-ink-faint" data-status-bar>
      {/* Invisible copy at natural width, to decide how many pieces fit. */}
      <div ref={ruler} aria-hidden className="pointer-events-none invisible absolute top-0 left-0 flex gap-3 whitespace-nowrap">
        {ordered.map((piece) => <span key={piece.id} className="flex shrink-0 items-center">{piece.node}</span>)}
      </div>

      {touch && !preview ? (
        <button ref={row as React.RefObject<HTMLButtonElement & HTMLDivElement>} type="button" onClick={() => setSheet(true)}
          aria-label={t('statusBar.label')} aria-haspopup="dialog"
          className="flex min-h-7 w-full min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap rounded-sm text-left focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:min-h-11">
          {main.map(inline)}
          {moreBadge}
          {tail.map(inline)}
        </button>
      ) : (
        <div ref={row} className="flex min-h-7 min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap">
          {main.map(inline)}
          {hidden.length > 0 && !preview ? (
            <Popover open={more} onOpenChange={setMore} label={t('statusBar.label')} side="top" align="end"
              trigger={(
                <button type="button" aria-label={t('statusBar.more', { count: hidden.length })}
                  className="shrink-0 rounded-sm hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
                  {moreBadge}
                </button>
              )}>
              <div className="w-80 max-w-[calc(100vw-1.5rem)] overflow-y-auto p-1">
                <PieceList pieces={hidden} onOpen={(place) => { setMore(false); open(place) }} />
              </div>
            </Popover>
          ) : moreBadge}
          {tail.map(inline)}
          {inlineConfigure ? (
            <span className={cx('flex shrink-0', tail.length === 0 && 'ml-auto')}>
              <IconButton label={t('statusBar.configure')} size="sm" onClick={onConfigure}>
                <SlidersHorizontal size={12} />
              </IconButton>
            </span>
          ) : null}
        </div>
      )}

      <Dialog.Root open={sheet} onOpenChange={setSheet}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
          <Dialog.Content aria-describedby={undefined}
            className="surface fixed inset-x-0 bottom-0 z-50 flex max-h-[80dvh] flex-col rounded-t-xl border-t border-line shadow-pop sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-96 sm:rounded-xl sm:border">
            <header className="flex shrink-0 items-center gap-2 border-b border-line py-1 pr-1 pl-4">
              <Dialog.Title className="flex-1 text-sm font-semibold">{t('statusBar.sheet.title')}</Dialog.Title>
              <Dialog.Close asChild><IconButton label={t('common.close')}><X size={18} /></IconButton></Dialog.Close>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
              {/* Everything, not only what overflowed: the line is a summary, this is the full view. */}
              <PieceList pieces={ordered.filter((piece) => !piece.end)} onOpen={(place) => { setSheet(false); open(place) }} />
            </div>
            <footer className="shrink-0 border-t border-line p-2 pb-[max(0.5rem,var(--sg-safe-bottom))]">
              <button type="button" onClick={() => { setSheet(false); onConfigure() }}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-md text-sm text-ink-soft hover:bg-surface-high hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
                <SlidersHorizontal size={15} />{t('statusBar.sheet.customize')}
              </button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

/** Name, value and detail of each piece; rows that lead somewhere are buttons. */
function PieceList({ pieces, onOpen }: { pieces: StatusPiece[]; onOpen: (place: StatusPlace) => void }) {
  return (
    <ul className="flex flex-col">
      {pieces.map((piece) => {
        const body = (
          <>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center justify-between gap-3 text-sm">
                {/* The name stays whole; a long value (worktree state, previews) truncates instead. */}
                <span className="shrink-0 text-ink-soft">{piece.name}</span>
                <span className="min-w-0 truncate text-right text-ink">{piece.value}</span>
              </span>
              <span className="whitespace-pre-line text-xs leading-relaxed text-ink-faint">{piece.detail}</span>
            </span>
            {piece.opens ? <ChevronRight size={15} aria-hidden className="shrink-0 text-ink-faint" /> : <span aria-hidden className="w-[15px] shrink-0" />}
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
