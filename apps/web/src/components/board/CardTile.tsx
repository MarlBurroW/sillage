import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Clock, GitBranch, GripVertical, Link2, MessageSquare, Paperclip } from 'lucide-react'
import type { KeyboardEventHandler, MouseEventHandler, TouchEventHandler } from 'react'
import type { CardDto } from '@sillage/protocol'
import { relativeDate } from '../../lib/dates'
import { useTranslate } from '../../lib/i18n'
import { AgentIcon } from '../AgentIcon'
import { cx } from '../ui'
import { GitHubMark } from './GitHubMark'
import { TagChip } from './CardTags'

/** Content fitting beneath titles without turning tiles into detail sheets. */
const EXCERPT_MAX = 120

interface CardTileProps {
  card: CardDto
  selected?: boolean
  /** Drag-overlay rendering: appearance only, no sorting or clicks. */
  disabled?: boolean
  overlay?: boolean
  /** Arrival-sorted boards show how long cards have occupied their column. */
  showArrival?: boolean
  onOpen?: () => void
}

/**
 * Board card. Pointer users grab the whole body: small handles were awkward, and sensor thresholds
 * (6px mouse, touch long-press) distinguish clicks. Keyboard uses Space for both actions, so the
 * body remains an open button and only the handle starts dragging, preserving mouse-free access.
 */
export function CardTile({ card, selected = false, overlay = false, disabled = false, showArrival = false, onOpen }: CardTileProps) {
  const t = useTranslate()
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } =
    useSortable({ id: card.id, disabled: overlay || disabled })
  // dnd-kit types listeners as Function; these come from its three sensors.
  const gesture = listeners as
    | { onMouseDown?: MouseEventHandler; onTouchStart?: TouchEventHandler; onKeyDown?: KeyboardEventHandler }
    | undefined

  const excerpt = card.description.trim().replace(/\s+/g, ' ')
  const sessions = card.conversations.length
  const links = card.references.length + card.referencedBy.length
  // Latest-session worktree identifies the working branch before starting another session.
  const branch = card.conversations.findLast((session) => session.worktreeName)?.worktreeName
  const agents = [...new Set(card.conversations.map((session) => session.agent))]
  // Detached cards are local again and lose the linked mark.
  const issue = card.external && !card.external.detached ? card.external : null

  const body = (
    <>
      <div className="flex items-baseline gap-1.5 pr-9 md:pr-5">
        <span className="shrink-0 text-[0.6875rem] font-medium text-ink-faint">#{card.number}</span>
        <p className="min-w-0 flex-1 text-sm font-semibold leading-relaxed text-ink">{card.title}</p>
      </div>
      {issue ? (
        <p
          className="mt-1.5 flex min-w-0 items-center gap-1 text-[0.6875rem] text-ink-faint"
          title={t('board.github.tile', { number: issue.number, author: issue.author ?? '?' })}
        >
          <GitHubMark size={11} className="shrink-0" />
          <span className="shrink-0 font-medium">{issue.number}</span>
          {issue.author ? <span className="min-w-0 truncate">· @{issue.author}</span> : null}
        </p>
      ) : null}

      {card.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {card.tags.map((tag) => <TagChip key={tag.id} tag={tag} />)}
        </div>
      ) : null}

      {excerpt ? (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-ink-faint">
          {excerpt.length > EXCERPT_MAX ? `${excerpt.slice(0, EXCERPT_MAX)}...` : excerpt}
        </p>
      ) : null}

      {sessions > 0 || links > 0 || branch || card.attachmentCount > 0 || showArrival ? (
        <div className="mt-3 flex flex-wrap border-t border-line/60 pt-2.5 items-center gap-x-2.5 gap-y-1 text-[0.6875rem] text-ink-faint">
          {showArrival ? (
            <span className="inline-flex items-center gap-1" title={t('board.card.arrived', { when: relativeDate(card.columnEnteredAt) })}>
              <Clock size={11} />
              {relativeDate(card.columnEnteredAt)}
            </span>
          ) : null}
          {agents.map((agent) => (
            <AgentIcon key={agent} agent={agent} size={11} />
          ))}
          {sessions > 0 ? (
            <span
              className="inline-flex items-center gap-1"
              title={t('board.card.sessions', { count: sessions })}
            >
              <MessageSquare size={11} />
              {sessions}
            </span>
          ) : null}
          {card.attachmentCount > 0 ? <span className="inline-flex items-center gap-1" title={t('board.files.title')}><Paperclip size={12} />{card.attachmentCount}</span> : null}
          {links > 0 ? (
            <span
              className="inline-flex items-center gap-1"
              title={t('board.card.links', { count: links })}
            >
              <Link2 size={11} />
              {links}
            </span>
          ) : null}
          {branch ? (
            <span className="inline-flex min-w-0 items-center gap-1" title={branch}>
              <GitBranch size={11} className="shrink-0" />
              <span className="max-w-28 truncate font-mono">{branch}</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  )

  const skin = cx(
    'surface relative rounded-xl border shadow-sm',
    selected ? 'border-accent' : 'border-line',
  )

  if (overlay) {
    return <div className={cx(skin, 'shadow-float rotate-2 p-2.5')}>{body}</div>
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      // Mouse and touch only; keyboard uses the handle as above.
      onMouseDown={gesture?.onMouseDown}
      onTouchStart={gesture?.onTouchStart}
      data-card-tile={card.number}
      className={cx(
        skin,
        'group/card transition-colors',
        // Placeholder left by the dragged card; its appearance lives in the overlay.
        isDragging ? 'opacity-40' : 'hover:border-line-strong',
      )}
    >
      <button data-card-open={card.id} type="button" onClick={onOpen} className="w-full p-3.5 text-left">
        {body}
      </button>

      {!disabled ? <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        onKeyDown={gesture?.onKeyDown}
        aria-label={t('board.card.drag', { number: card.number })}
        className={cx(
          'absolute top-0 right-0 flex size-11 items-center justify-center cursor-grab touch-none rounded text-ink-faint md:top-1.5 md:right-1 md:size-6',
          'opacity-0 transition-opacity group-hover/card:opacity-100 focus-visible:opacity-100',
          // Touch has no hover, so keep the handle visible.
          '[@media(hover:none)]:opacity-60',
        )}
      >
        <GripVertical size={14} />
      </button> : null}
    </div>
  )
}
