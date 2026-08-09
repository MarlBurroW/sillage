import { SquareKanban } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { CardLinkDto } from '@sillage/protocol'
import { columnLabel } from '../board/columns'
import { cx } from '../ui'
import { useTranslate } from '../../lib/i18n'

/**
 * Liste des cartes proposées après un `#`.
 *
 * Posée au-dessus de la zone de saisie comme celle des fichiers, et pour la même
 * raison : sur téléphone, le clavier virtuel occupe tout le bas de l'écran.
 */
export function CardPicker({
  cards,
  active,
  loading,
  onPick,
  onHover,
}: {
  cards: CardLinkDto[]
  active: number
  loading: boolean
  onPick: (card: CardLinkDto) => void
  onHover: (index: number) => void
}) {
  const t = useTranslate()
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!loading && cards.length === 0) {
    return (
      <div className="surface mb-1.5 rounded-lg border border-line p-2.5 text-xs text-ink-faint shadow-float">
        {t('card.picker.empty')}
      </div>
    )
  }

  return (
    <ul
      ref={list}
      role="listbox"
      aria-label={t('card.picker.aria')}
      className="surface mb-1.5 max-h-56 overflow-y-auto rounded-lg border border-line p-1 shadow-float"
    >
      {cards.map((card, index) => (
        <li key={card.id}>
          <button
            type="button"
            role="option"
            aria-selected={index === active}
            // `onMouseDown` : un `onClick` laisserait d'abord le champ perdre le focus,
            // ce qui referme la liste avant que la sélection soit prise en compte.
            onMouseDown={(event) => {
              event.preventDefault()
              onPick(card)
            }}
            onMouseEnter={() => onHover(index)}
            className={cx(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
              index === active ? 'bg-accent-wash text-ink' : 'text-ink-soft',
            )}
          >
            <SquareKanban size={13} className="shrink-0 text-ink-faint" />
            <span className="shrink-0 text-ink-faint">#{card.number}</span>
            <span className="min-w-0 flex-1 truncate">{card.title}</span>
            <span className="shrink-0 text-[0.6875rem] text-ink-faint">
              {columnLabel(card.column)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
