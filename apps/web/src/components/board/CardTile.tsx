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

/** Ce qui tient sous le titre sans transformer la tuile en fiche. */
const EXCERPT_MAX = 120

interface CardTileProps {
  card: CardDto
  selected?: boolean
  /** Rendu dans le calque de glissement : ni tri, ni clic, seulement l'apparence. */
  disabled?: boolean
  overlay?: boolean
  /** Le board est trié par arrivée : la tuile dit depuis quand elle est dans la colonne. */
  showArrival?: boolean
  onOpen?: () => void
}

/**
 * Une carte du board.
 *
 * Au pointeur, la carte entière se saisit : viser la petite poignée était la gêne, et le
 * seuil de déplacement des capteurs (6 px à la souris, un appui long au doigt) suffit à
 * distinguer le clic du geste. Au clavier non, la barre d'espace servant aux deux : le
 * corps reste un bouton qui ouvre la carte, et seule la poignée prend le glissement au
 * clavier. Une carte qu'on ne pourrait plus ouvrir sans souris serait un recul.
 */
export function CardTile({ card, selected = false, overlay = false, disabled = false, showArrival = false, onOpen }: CardTileProps) {
  const t = useTranslate()
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } =
    useSortable({ id: card.id, disabled: overlay || disabled })
  // dnd-kit type ses écouteurs en `Function` ; ce sont ceux de ses trois capteurs.
  const gesture = listeners as
    | { onMouseDown?: MouseEventHandler; onTouchStart?: TouchEventHandler; onKeyDown?: KeyboardEventHandler }
    | undefined

  const excerpt = card.description.trim().replace(/\s+/g, ' ')
  const sessions = card.conversations.length
  const links = card.references.length + card.referencedBy.length
  // Le worktree de la dernière session dit dans quelle branche le chantier vit, ce qui
  // est le repère qu'on cherche avant d'en ouvrir une de plus.
  const branch = card.conversations.findLast((session) => session.worktreeName)?.worktreeName
  const agents = [...new Set(card.conversations.map((session) => session.agent))]
  // Une carte détachée est redevenue locale : elle ne porte plus la marque.
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
      // Souris et doigt seulement : le clavier passe par la poignée, voir plus haut.
      onMouseDown={gesture?.onMouseDown}
      onTouchStart={gesture?.onTouchStart}
      data-card-tile={card.number}
      className={cx(
        skin,
        'group/card transition-colors',
        // Le trou laissé par la carte tenue, le calque en portant l'apparence.
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
          // Sans survol au doigt, la poignée doit rester visible ou elle n'existe pas.
          '[@media(hover:none)]:opacity-60',
        )}
      >
        <GripVertical size={14} />
      </button> : null}
    </div>
  )
}
