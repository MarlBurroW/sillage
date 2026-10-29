import * as Dialog from '@radix-ui/react-dialog'
import { Search, SquareKanban, Unlink, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CARD_CLOSED_COLUMNS, CARD_COLUMNS, type CardDto, type ConversationDto } from '@sillage/protocol'
import { useCards } from '../../lib/cards'
import { useSetConversationCard } from '../../lib/conversations'
import { useTranslate } from '../../lib/i18n'
import { Badge, Banner, Button, IconButton } from '../ui'
import { TagChip } from '../board/CardTags'
import { COLUMN_TONES, columnLabel } from '../board/columns'

/**
 * Choosing the card a conversation handles, for sessions not started from the board. Open cards
 * come first in board order; closed ones stay reachable by search, since a session may well be
 * finishing work someone already marked done.
 */
export function CardLinkDialog({ conversation, open, onClose, onLinked }: {
  conversation: ConversationDto & { projectId: string }
  open: boolean
  onClose: () => void
  /** After attaching, so the caller can show the card. */
  onLinked: () => void
}) {
  const t = useTranslate()
  const { data: cards, isPending } = useCards(open ? conversation.projectId : undefined)
  const setCard = useSetConversationCard()
  const [query, setQuery] = useState('')
  const search = query.trim().replace(/^#/, '').toLocaleLowerCase()
  const rank = (card: CardDto) => CARD_COLUMNS.indexOf(card.column)
  const shown = (cards ?? [])
    .filter((card) => (search
      ? `${card.number} ${card.title} ${card.tags.map((tag) => tag.name).join(' ')}`.toLocaleLowerCase().includes(search)
      : !CARD_CLOSED_COLUMNS.includes(card.column)))
    .sort((a, b) => rank(a) - rank(b) || a.position - b.position)

  const attach = (cardId: string | null) => setCard.mutate({ id: conversation.id, cardId }, {
    onSuccess: () => {
      setQuery('')
      if (cardId) onLinked()
      onClose()
    },
  })

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !setCard.isPending) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-sm" />
        <Dialog.Content aria-describedby={undefined} className="surface fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-2xl border border-line shadow-pop sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[min(560px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl">
          <header className="flex items-center justify-between border-b border-line px-5 py-4">
            <Dialog.Title className="text-lg font-semibold">{t('conversation.card.link.title')}</Dialog.Title>
            <IconButton label={t('board.panel.close')} onClick={onClose}><X size={18} /></IconButton>
          </header>
          {conversation.card ? (
            <div className="flex flex-wrap items-center gap-2 border-b border-line bg-sunken/50 px-5 py-3 text-sm">
              <SquareKanban size={15} className="shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate">
                {t('conversation.card.link.current', { number: conversation.card.number, title: conversation.card.title })}
              </span>
              <Button size="sm" variant="ghost" icon={<Unlink size={14} />} disabled={setCard.isPending} onClick={() => attach(null)}>
                {t('conversation.card.detach')}
              </Button>
            </div>
          ) : null}
          <label className="flex items-center gap-2 border-b border-line px-5">
            <Search size={15} className="shrink-0 text-ink-faint" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t('conversation.card.link.search')}
              placeholder={t('conversation.card.link.search')}
              className="min-h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-faint"
            />
          </label>
          <ul className="min-h-0 flex-1 overflow-y-auto p-2" aria-label={t('conversation.card.link.results')}>
            {shown.map((card) => (
              <li key={card.id}>
                <button
                  type="button"
                  disabled={setCard.isPending || card.id === conversation.card?.id}
                  onClick={() => attach(card.id)}
                  className="flex min-h-11 w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-surface-high disabled:opacity-45"
                >
                  <span className="shrink-0 pt-0.5 text-xs text-ink-faint">#{card.number}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{card.title}</span>
                    {card.tags.length > 0 ? (
                      <span className="mt-1 flex flex-wrap gap-1">{card.tags.map((tag) => <TagChip key={tag.id} tag={tag} />)}</span>
                    ) : null}
                  </span>
                  <Badge tone={COLUMN_TONES[card.column]}>{columnLabel(card.column)}</Badge>
                </button>
              </li>
            ))}
            {!isPending && shown.length === 0 ? (
              <li className="px-2 py-4 text-sm text-ink-faint">{t(search ? 'card.picker.empty' : 'conversation.card.link.noneOpen')}</li>
            ) : null}
          </ul>
          {setCard.isError ? <div className="px-5 pb-3"><Banner>{setCard.error.message}</Banner></div> : null}
          <footer className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
            <p className="text-xs text-ink-faint">{t('conversation.card.link.hint')}</p>
            <Link to={`/p/${conversation.projectId}/board`} className="shrink-0 text-xs text-accent hover:underline">{t('conversation.card.link.board')}</Link>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
