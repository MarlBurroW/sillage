import { GitBranch, Play, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CARD_COLUMNS, type CardColumn, type CardDto } from '@sillage/protocol'
import { useDeleteCard, useUpdateCard } from '../../lib/cards'
import { translate, useTranslate } from '../../lib/i18n'
import { AgentIcon } from '../AgentIcon'
import { Badge, Button, IconButton, cx } from '../ui'
import { COLUMN_TONES, columnLabel } from './columns'

interface CardPanelProps {
  card: CardDto
  projectId: string
  onClose: () => void
  onSelectCard: (number: number) => void
}

/**
 * Le détail d'une carte, à côté du board plutôt qu'à sa place.
 *
 * Garder les colonnes visibles derrière compte pour l'usage réel, qui est de parcourir,
 * ouvrir, refermer. Au doigt la place manque, et le panneau recouvre alors le board.
 */
export function CardPanel({ card, projectId, onClose, onSelectCard }: CardPanelProps) {
  const t = useTranslate()
  const navigate = useNavigate()
  const updateCard = useUpdateCard(projectId)
  const deleteCard = useDeleteCard(projectId)

  const [title, setTitle] = useState(card.title)
  const [description, setDescription] = useState(card.description)

  // Le serveur fait foi dès qu'on change de carte ou qu'il renvoie la sienne.
  useEffect(() => {
    setTitle(card.title)
    setDescription(card.description)
  }, [card.id, card.title, card.description])

  const dirty = title !== card.title || description !== card.description
  const save = () => {
    if (!title.trim() || !dirty) return
    updateCard.mutate({ id: card.id, title: title.trim(), description })
  }

  return (
    <aside
      className={cx(
        'surface flex flex-col overflow-y-auto border-line',
        // Au doigt : par-dessus le board, qui n'a pas la place de tenir à côté.
        'absolute inset-0 z-20 md:static md:z-auto md:w-96 md:shrink-0 md:border-l',
      )}
    >
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <span className="text-xs font-medium text-ink-faint">#{card.number}</span>
        <Badge tone={COLUMN_TONES[card.column]}>{columnLabel(card.column)}</Badge>
        <div className="flex-1" />
        <IconButton label={t('board.panel.close')} size="sm" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </header>

      <div className="flex flex-col gap-4 p-3">
        <div className="flex flex-col gap-2">
          <textarea
            value={title}
            rows={2}
            aria-label={t('board.card.title')}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full resize-none rounded-md border border-transparent bg-transparent px-2 py-1 text-base leading-snug font-semibold text-ink outline-none hover:border-line focus:border-line-strong"
          />
          <textarea
            value={description}
            rows={10}
            aria-label={t('board.card.description')}
            placeholder={t('board.card.description.placeholder')}
            onChange={(event) => setDescription(event.target.value)}
            className="w-full resize-y rounded-md border border-line bg-sunken px-2.5 py-2 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
          />
          {dirty ? (
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={!title.trim() || updateCard.isPending} onClick={save}>
                {t('board.card.save')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setTitle(card.title)
                  setDescription(card.description)
                }}
              >
                {t('board.card.cancel')}
              </Button>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium tracking-wide text-ink-faint uppercase">
            {t('board.card.column')}
          </h3>
          <div className="flex flex-wrap gap-1">
            {CARD_COLUMNS.map((column) => (
              <button
                key={column}
                type="button"
                disabled={column === card.column}
                onClick={() => updateCard.mutate({ id: card.id, column })}
                className={cx(
                  'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                  column === card.column
                    ? 'bg-accent-wash text-accent'
                    : 'text-ink-faint hover:bg-surface-high hover:text-ink',
                )}
              >
                {columnLabel(column)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium tracking-wide text-ink-faint uppercase">
            {t('board.card.sessions.title')}
          </h3>
          {card.conversations.length === 0 ? (
            <p className="text-sm text-ink-faint">{t('board.card.sessions.none')}</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {card.conversations.map((session) => (
                <li key={session.id}>
                  <Link
                    to={`/p/${projectId}/c/${session.id}`}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-high"
                  >
                    <AgentIcon agent={session.agent} size={13} />
                    <span
                      className={cx(
                        'min-w-0 flex-1 truncate text-sm',
                        session.archivedAt ? 'text-ink-faint' : 'text-ink-soft',
                      )}
                    >
                      {session.title}
                    </span>
                    {session.worktreeName ? (
                      <span className="flex shrink-0 items-center gap-1 font-mono text-[0.6875rem] text-ink-faint">
                        <GitBranch size={11} />
                        {session.worktreeName}
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Button
            className="mt-1 self-start"
            icon={<Play size={15} />}
            onClick={() => navigate(`/p/${projectId}/c/new?card=${card.id}`)}
          >
            {t('board.card.launch')}
          </Button>
        </div>

        <CardLinkList
          title={t('board.card.references')}
          links={card.references}
          onSelect={onSelectCard}
        />
        <CardLinkList
          title={t('board.card.referencedBy')}
          links={card.referencedBy}
          onSelect={onSelectCard}
        />
      </div>

      <div className="mt-auto flex items-center gap-3 border-t border-line px-3 py-2.5">
        <p className="min-w-0 flex-1 text-[0.6875rem] text-ink-faint">
          {t('board.card.author', { name: card.createdByName })}
          {' · '}
          {t('board.card.remove.notice')}
        </p>
        <IconButton
          label={t('board.card.remove')}
          size="sm"
          disabled={deleteCard.isPending}
          onClick={() => {
            if (!confirm(translate('board.card.remove.confirm', { number: card.number }))) return
            deleteCard.mutate(card.id, { onSuccess: onClose })
          }}
        >
          <Trash2 size={15} />
        </IconButton>
      </div>
    </aside>
  )
}

function CardLinkList({
  title,
  links,
  onSelect,
}: {
  title: string
  links: CardDto['references']
  onSelect: (number: number) => void
}) {
  if (links.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-ink-faint uppercase">{title}</h3>
      <ul className="flex flex-col gap-0.5">
        {links.map((link) => (
          <li key={link.id}>
            <button
              type="button"
              onClick={() => onSelect(link.number)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-ink-soft hover:bg-surface-high hover:text-ink"
            >
              <span className="shrink-0 text-[0.6875rem] text-ink-faint">#{link.number}</span>
              <span className="min-w-0 flex-1 truncate">{link.title}</span>
              <ColumnDot column={link.column} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** L'état d'une carte citée, sans le poids d'une pastille pleine dans une liste. */
function ColumnDot({ column }: { column: CardColumn }) {
  const tone = COLUMN_TONES[column]
  return (
    <span
      title={columnLabel(column)}
      className={cx(
        'size-1.5 shrink-0 rounded-full',
        tone === 'accent' && 'bg-accent',
        tone === 'caution' && 'bg-caution',
        tone === 'positive' && 'bg-positive',
        tone === 'neutral' && 'bg-line-strong',
      )}
    />
  )
}
