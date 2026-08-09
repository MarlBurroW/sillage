import { GitBranch, Play, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CARD_COLUMNS, type CardColumn, type CardDto } from '@sillage/protocol'
import { useDeleteCard, useUpdateCard } from '../../lib/cards'
import { translate, useTranslate } from '../../lib/i18n'
import { AgentIcon } from '../AgentIcon'
import { Badge, Button, Field, Select, cx, type SelectOption } from '../ui'
import { columnLabel } from './columns'

function columnOptions(): SelectOption<CardColumn>[] {
  return CARD_COLUMNS.map((column) => ({ value: column, label: columnLabel(column) }))
}

interface CardPanelProps {
  card: CardDto
  projectId: string
  onClose: () => void
  onSelectCard: (number: number) => void
}

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

  return (
    <aside className="surface flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-line p-4 md:w-96 md:border-l">
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="text-xs font-medium text-ink-faint">#{card.number}</span>
          <p className="text-sm text-ink-soft">
            {t('board.card.author', { name: card.createdByName })}
          </p>
        </div>
        <Button variant="ghost" size="sm" icon={<X size={15} />} onClick={onClose}>
          {t('board.panel.close')}
        </Button>
      </header>

      <Field
        label={t('board.card.title')}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink-soft">{t('board.card.description')}</span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={8}
          placeholder={t('board.card.description.placeholder')}
          className="w-full resize-y rounded-md border border-line bg-sunken px-3 py-2 text-sm text-ink outline-none focus:border-line-strong"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={!dirty || !title.trim() || updateCard.isPending}
          onClick={() =>
            updateCard.mutate({ id: card.id, title: title.trim(), description })
          }
        >
          {t('board.card.save')}
        </Button>
        {dirty ? (
          <Button
            variant="ghost"
            onClick={() => {
              setTitle(card.title)
              setDescription(card.description)
            }}
          >
            {t('board.card.cancel')}
          </Button>
        ) : null}
      </div>

      <Select
        label={t('board.card.column')}
        value={card.column}
        onChange={(column) => updateCard.mutate({ id: card.id, column })}
        options={columnOptions()}
      />

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-ink-soft">{t('board.card.sessions.title')}</h3>
        {card.conversations.length === 0 ? (
          <p className="text-sm text-ink-faint">{t('board.card.sessions.none')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {card.conversations.map((session) => (
              <li key={session.id}>
                <Link
                  to={`/p/${projectId}/c/${session.id}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-high"
                >
                  <AgentIcon agent={session.agent} size={14} />
                  <span
                    className={cx(
                      'min-w-0 flex-1 truncate text-sm',
                      session.archivedAt ? 'text-ink-faint' : 'text-ink-soft',
                    )}
                  >
                    {session.title}
                  </span>
                  {session.worktreeName ? (
                    <Badge icon={<GitBranch size={11} />}>{session.worktreeName}</Badge>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Button
          icon={<Play size={15} />}
          onClick={() => navigate(`/p/${projectId}/c/new?card=${card.id}`)}
        >
          {t('board.card.launch')}
        </Button>
      </div>

      {card.references.length > 0 || card.referencedBy.length > 0 ? (
        <div className="flex flex-col gap-3">
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
      ) : null}

      <div className="mt-auto flex items-center gap-3 border-t border-line pt-3">
        <p className="min-w-0 flex-1 text-xs text-ink-faint">{t('board.card.remove.notice')}</p>
        <Button
          variant="danger"
          size="sm"
          icon={<Trash2 size={15} />}
          disabled={deleteCard.isPending}
          onClick={() => {
            if (!confirm(translate('board.card.remove.confirm', { number: card.number }))) return
            deleteCard.mutate(card.id, { onSuccess: onClose })
          }}
        >
          {t('board.card.remove')}
        </Button>
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
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-medium text-ink-soft">{title}</h3>
      <ul className="flex flex-wrap gap-1.5">
        {links.map((link) => (
          <li key={link.id}>
            <button
              type="button"
              onClick={() => onSelect(link.number)}
              className="rounded-full bg-surface-high px-2 py-0.5 text-xs text-ink-soft hover:text-ink"
            >
              #{link.number} {link.title}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
