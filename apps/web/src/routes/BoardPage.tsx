import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  CARD_CLOSED_COLUMNS,
  CARD_COLUMNS,
  type CardColumn,
  type CardDto,
} from '@sillage/protocol'
import { CardPanel } from '../components/board/CardPanel'
import { CardTile } from '../components/board/CardTile'
import { columnLabel } from '../components/board/columns'
import { Button, EmptyState, Field, cx } from '../components/ui'
import { useCards, useCreateCard, useReorderCards, type CardColumnOrder } from '../lib/cards'
import { useTranslate } from '../lib/i18n'
import { useProjects } from '../lib/projects'
import { useSidebarHidden } from '../lib/sidebar'
import { useMediaQuery } from '../lib/viewport'

/** Même seuil que la coque : au-delà, la sidebar et les colonnes tiennent côte à côte. */
const WIDE = '(min-width: 768px)'

export function BoardPage() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const t = useTranslate()
  const wide = useMediaQuery(WIDE)
  const sidebarHidden = useSidebarHidden()

  const { data: projects } = useProjects()
  const { data: cards, isPending } = useCards(projectId)
  const reorder = useReorderCards(projectId ?? '')

  const [visibleColumn, setVisibleColumn] = useState<CardColumn>('todo')
  const [showClosed, setShowClosed] = useState(false)
  const sensors = useBoardSensors()

  const project = projects?.find((entry) => entry.id === projectId)

  /** Cartes par colonne, chacune dans son ordre. */
  const byColumn = useMemo(() => {
    const grouped = new Map<CardColumn, CardDto[]>(CARD_COLUMNS.map((column) => [column, []]))
    for (const card of cards ?? []) grouped.get(card.column)?.push(card)
    for (const list of grouped.values()) list.sort((a, b) => a.position - b.position)
    return grouped
  }, [cards])

  const openNumber = Number(params.get('carte'))
  const openCard = (cards ?? []).find((card) => card.number === openNumber) ?? null
  const showCard = (number: number | null) => {
    const next = new URLSearchParams(params)
    if (number === null) next.delete('carte')
    else next.set('carte', String(number))
    setParams(next, { replace: true })
  }

  if (!projectId) return null
  if (isPending) return null
  if (!project) return <EmptyState title={t('project.notFound')} />

  const columnOf = (cardId: string): CardColumn | undefined =>
    (cards ?? []).find((card) => card.id === cardId)?.column

  /**
   * Un déplacement réécrit une colonne, ou deux quand la carte en change.
   *
   * La cible est soit une carte, soit la colonne elle-même : lâcher dans le vide d'une
   * colonne vide n'a aucune carte à survoler, et sans ce second cas une colonne vidée
   * ne pourrait plus jamais rien recevoir.
   */
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return

    const cardId = String(active.id)
    const from = columnOf(cardId)
    if (!from) return

    const overId = String(over.id)
    const to = CARD_COLUMNS.includes(overId as CardColumn)
      ? (overId as CardColumn)
      : columnOf(overId)
    if (!to) return

    const source = (byColumn.get(from) ?? []).map((card) => card.id)

    if (from === to) {
      const oldIndex = source.indexOf(cardId)
      const newIndex = source.indexOf(overId)
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return
      reorder.mutate([{ column: from, ids: arrayMove(source, oldIndex, newIndex) }])
      return
    }

    const target = (byColumn.get(to) ?? []).map((card) => card.id)
    const at = target.indexOf(overId)
    const inserted = [...target]
    inserted.splice(at === -1 ? target.length : at, 0, cardId)

    const columns: CardColumnOrder[] = [
      { column: from, ids: source.filter((id) => id !== cardId) },
      { column: to, ids: inserted },
    ]
    reorder.mutate(columns)
  }

  const open = CARD_COLUMNS.filter((column) => !CARD_CLOSED_COLUMNS.includes(column))
  const closed = CARD_CLOSED_COLUMNS.filter((column) => (byColumn.get(column) ?? []).length > 0)
  const shown = wide
    ? [...open, ...(showClosed ? CARD_CLOSED_COLUMNS : [])]
    : [visibleColumn]

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={cx(
            'flex flex-wrap items-center gap-3 border-b border-line px-4 py-3',
            sidebarHidden && 'md:pl-14',
          )}
        >
          <h1 className="text-sm font-semibold tracking-tight">
            {t('board.title', { project: project.name })}
          </h1>
          <div className="flex-1" />
          {wide && closed.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setShowClosed((value) => !value)}>
              {showClosed ? t('board.closed.hide') : t('board.closed.show')}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/p/${projectId}/c/new`)}
          >
            {t('board.newConversation')}
          </Button>
        </header>

        {!wide ? (
          <nav className="flex gap-1 overflow-x-auto border-b border-line px-2 py-2">
            {CARD_COLUMNS.map((column) => {
              const count = (byColumn.get(column) ?? []).length
              // Les colonnes de sortie ne se proposent au doigt que si elles ont
              // quelque chose : trois onglets utiles valent mieux que cinq.
              if (count === 0 && CARD_CLOSED_COLUMNS.includes(column)) return null
              return (
                <button
                  key={column}
                  type="button"
                  onClick={() => setVisibleColumn(column)}
                  className={cx(
                    'shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    column === visibleColumn
                      ? 'bg-accent-wash text-accent'
                      : 'text-ink-faint hover:text-ink',
                  )}
                >
                  {columnLabel(column)} {count > 0 ? count : null}
                </button>
              )
            })}
          </nav>
        ) : null}

        {(cards ?? []).length === 0 ? (
          <p className="px-4 pt-4 text-sm text-ink-faint">{t('board.empty')}</p>
        ) : null}

        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
            {shown.map((column) => (
              <BoardColumn
                key={column}
                column={column}
                cards={byColumn.get(column) ?? []}
                projectId={projectId}
                draggable={wide}
                onOpenCard={(card) => showCard(card.number)}
              />
            ))}
          </div>
        </DndContext>
      </div>

      {openCard ? (
        <CardPanel
          card={openCard}
          projectId={projectId}
          onClose={() => showCard(null)}
          onSelectCard={showCard}
        />
      ) : null}
    </div>
  )
}

/**
 * Souris : un seuil de déplacement, pour qu'un clic sur une carte reste un clic.
 * Tactile : un appui long, sinon le glissement volerait le défilement de la colonne.
 */
function useBoardSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  )
}

function BoardColumn({
  column,
  cards,
  projectId,
  draggable,
  onOpenCard,
}: {
  column: CardColumn
  cards: CardDto[]
  projectId: string
  draggable: boolean
  onOpenCard: (card: CardDto) => void
}) {
  const t = useTranslate()
  const createCard = useCreateCard(projectId)
  const [title, setTitle] = useState('')
  const [adding, setAdding] = useState(false)
  // La colonne est elle-même une cible : sans elle, une colonne vide n'aurait aucune
  // carte à survoler et ne pourrait plus rien recevoir.
  const { setNodeRef } = useDroppable({ id: column })

  const submit = () => {
    const value = title.trim()
    if (!value) return
    createCard.mutate(
      { title: value, column },
      {
        onSuccess: () => {
          setTitle('')
          setAdding(false)
        },
      },
    )
  }

  return (
    <section
      ref={setNodeRef}
      className="flex w-full shrink-0 flex-col gap-2 md:w-72"
      aria-label={columnLabel(column)}
    >
      <header className="flex items-center gap-2 px-1">
        <h2 className="text-xs font-semibold tracking-wide text-ink-soft uppercase">
          {columnLabel(column)}
        </h2>
        <span className="text-xs text-ink-faint">{cards.length}</span>
      </header>

      <SortableContext items={cards.map((card) => card.id)} strategy={verticalListSortingStrategy}>
        <ul className="flex min-h-2 flex-col gap-2">
          {cards.map((card) => (
            <CardTile
              key={card.id}
              card={card}
              draggable={draggable}
              onOpen={() => onOpenCard(card)}
            />
          ))}
        </ul>
      </SortableContext>

      {adding ? (
        <div className="flex flex-col gap-2">
          <Field
            label={t('board.card.title')}
            value={title}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
              if (event.key === 'Escape') setAdding(false)
            }}
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={!title.trim() || createCard.isPending} onClick={submit}>
              {t('board.card.add')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              {t('board.card.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus size={14} />}
          onClick={() => setAdding(true)}
          className="justify-start"
        >
          {t('board.card.new')}
        </Button>
      )}
    </section>
  )
}
