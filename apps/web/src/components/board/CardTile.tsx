import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Link2, MessageSquare } from 'lucide-react'
import type { CardDto } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

interface CardTileProps {
  card: CardDto
  /** Faux au doigt : une colonne à la fois y est visible, il n'y a nulle part où glisser. */
  draggable: boolean
  onOpen: () => void
}

export function CardTile({ card, draggable, onOpen }: CardTileProps) {
  const t = useTranslate()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    disabled: !draggable,
  })

  const sessions = card.conversations.length
  const links = card.references.length + card.referencedBy.length

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      className={cx(
        'surface rounded-lg border border-line p-2.5 transition-colors',
        isDragging ? 'shadow-float z-10 bg-surface-high opacity-90' : 'hover:border-line-strong',
      )}
    >
      <button type="button" onClick={onOpen} className="w-full text-left">
        <span className="text-xs font-medium text-ink-faint">#{card.number}</span>
        <p className="mt-0.5 text-sm text-ink">{card.title}</p>
        {sessions > 0 || links > 0 ? (
          <div className="mt-2 flex items-center gap-3 text-xs text-ink-faint">
            {sessions > 0 ? (
              <span
                className="inline-flex items-center gap-1"
                title={t('board.card.sessions', { count: sessions })}
              >
                <MessageSquare size={11} />
                {sessions}
              </span>
            ) : null}
            {links > 0 ? (
              <span
                className="inline-flex items-center gap-1"
                title={t('board.card.links', { count: links })}
              >
                <Link2 size={11} />
                {links}
              </span>
            ) : null}
          </div>
        ) : null}
      </button>
    </li>
  )
}
