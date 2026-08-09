import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CARD_CLOSED_COLUMNS, CARD_COLUMNS, type CardColumn, type CardDto } from '@sillage/protocol'
import { CardPanel } from '../components/board/CardPanel'
import { CardTile } from '../components/board/CardTile'
import { columnLabel } from '../components/board/columns'
import { Button, EmptyState, IconButton, cx } from '../components/ui'
import { useCards, useCreateCard, useReorderCards, type CardColumnOrder } from '../lib/cards'
import { useTranslate } from '../lib/i18n'
import { useProjects } from '../lib/projects'
import { useSidebarHidden } from '../lib/sidebar'
import { useMediaQuery } from '../lib/viewport'

/** Même seuil que la coque : au-delà, la sidebar et les colonnes tiennent côte à côte. */
const WIDE = '(min-width: 768px)'

/** Ordre des cartes par colonne, la forme sur laquelle le glissement travaille. */
type Layout = Map<CardColumn, string[]>

function layoutOf(cards: CardDto[]): Layout {
  const grouped: Layout = new Map(CARD_COLUMNS.map((column) => [column, []]))
  for (const card of [...cards].sort((a, b) => a.position - b.position)) {
    grouped.get(card.column)?.push(card.id)
  }
  return grouped
}

function columnOf(layout: Layout, cardId: string): CardColumn | undefined {
  for (const [column, ids] of layout) {
    if (ids.includes(cardId)) return column
  }
  return undefined
}

/**
 * Ce que le pointeur survole, avec un repli sur le recouvrement des rectangles.
 *
 * `pointerWithin` seul est le plus juste quand le pointeur est sur une cible, et ne
 * rend rien du tout quand il passe entre deux colonnes : le geste paraît alors mort
 * dans les gouttières. Le repli garde une cible dans ces creux.
 */
const collisionDetection: CollisionDetection = (args) => {
  const under = pointerWithin(args)
  return under.length > 0 ? under : rectIntersection(args)
}

/** La colonne visée par un survol : soit une carte, soit le fond d'une colonne. */
function targetColumn(layout: Layout, overId: string): CardColumn | undefined {
  if (CARD_COLUMNS.includes(overId as CardColumn)) return overId as CardColumn
  return columnOf(layout, overId)
}

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
  /**
   * Disposition pendant le geste, nulle au repos.
   *
   * Le glissement doit se voir avant d'être lâché : sans cet état, une carte tirée vers
   * une autre colonne y reste invisible jusqu'au relâchement, et on tire à l'aveugle.
   */
  const [dragging, setDragging] = useState<{ id: string; layout: Layout } | null>(null)
  const sensors = useSensors(
    // Un seuil de déplacement, pour qu'un clic sur une carte reste un clic.
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // Un appui long, sinon le glissement volerait le défilement de la colonne.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const byId = useMemo(
    () => new Map((cards ?? []).map((card) => [card.id, card])),
    [cards],
  )
  const settled = useMemo(() => layoutOf(cards ?? []), [cards])
  const layout = dragging?.layout ?? settled

  const project = projects?.find((entry) => entry.id === projectId)
  const held = dragging ? (byId.get(dragging.id) ?? null) : null

  const openNumber = Number(params.get('carte'))
  const openCard = (cards ?? []).find((card) => card.number === openNumber) ?? null
  const showCard = (number: number | null) => {
    const next = new URLSearchParams(params)
    if (number === null) next.delete('carte')
    else next.set('carte', String(number))
    setParams(next, { replace: true })
  }

  const onDragStart = (event: DragStartEvent) => {
    setDragging({ id: String(event.active.id), layout: settled })
  }

  /**
   * Traversée d'une colonne à l'autre, jouée pendant le geste.
   *
   * Seul le changement de colonne se traite ici : réordonner dans la même colonne à
   * chaque survol ferait vibrer la liste sous le curseur, alors que le lâcher suffit.
   */
  const onDragOver = (event: DragOverEvent) => {
    const { active, over } = event
    if (!over || !dragging) return

    const cardId = String(active.id)
    const from = columnOf(dragging.layout, cardId)
    const to = targetColumn(dragging.layout, String(over.id))
    if (!from || !to || from === to) return

    const next: Layout = new Map(dragging.layout)
    next.set(
      from,
      (next.get(from) ?? []).filter((id) => id !== cardId),
    )
    const target = [...(next.get(to) ?? [])]
    const at = target.indexOf(String(over.id))
    target.splice(at === -1 ? target.length : at, 0, cardId)
    next.set(to, target)
    setDragging({ id: cardId, layout: next })
  }

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    const snapshot = dragging
    setDragging(null)
    if (!snapshot || !over) return

    const cardId = String(active.id)
    const column = columnOf(snapshot.layout, cardId)
    if (!column) return

    const ids = snapshot.layout.get(column) ?? []
    const from = ids.indexOf(cardId)
    const to = CARD_COLUMNS.includes(String(over.id) as CardColumn)
      ? ids.length - 1
      : ids.indexOf(String(over.id))
    const ordered = from === -1 || to === -1 || from === to ? ids : arrayMove(ids, from, to)

    // Seules les colonnes dont le contenu a changé sont réécrites, et chacune en
    // entier : le serveur refuse une colonne partielle, qui laisserait les cartes
    // omises intercalées au hasard parmi les nouvelles.
    const changed: CardColumnOrder[] = []
    for (const [key, before] of settled) {
      const after = key === column ? ordered : (snapshot.layout.get(key) ?? [])
      if (before.length !== after.length || before.some((id, index) => id !== after[index])) {
        changed.push({ column: key, ids: after })
      }
    }
    if (changed.length > 0) reorder.mutate(changed)
  }

  if (!projectId) return null
  if (isPending) return null
  if (!project) return <EmptyState title={t('project.notFound')} />

  const open = CARD_COLUMNS.filter((column) => !CARD_CLOSED_COLUMNS.includes(column))
  const hasClosed = CARD_CLOSED_COLUMNS.some((column) => (layout.get(column) ?? []).length > 0)
  const shown = wide ? [...open, ...(showClosed ? CARD_CLOSED_COLUMNS : [])] : [visibleColumn]

  return (
    // `relative` : au doigt, le panneau de détail se pose en absolu par-dessus le board.
    <div className="relative flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={cx(
            'flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2',
            sidebarHidden && 'md:pl-14',
          )}
        >
          <h1 className="truncate text-sm font-semibold tracking-tight">{project.name}</h1>
          <span className="rounded-full bg-surface-high px-1.5 py-0.5 text-[0.6875rem] text-ink-faint">
            {t('board.cardCount', { count: (cards ?? []).length })}
          </span>
          <div className="flex-1" />
          {wide && hasClosed ? (
            <Button
              variant="ghost"
              size="sm"
              icon={showClosed ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              onClick={() => setShowClosed((value) => !value)}
            >
              {t('board.closed')}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${projectId}/c/new`)}>
            {t('board.newConversation')}
          </Button>
        </header>

        {!wide ? (
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2 py-1.5">
            {CARD_COLUMNS.map((column) => {
              const count = (layout.get(column) ?? []).length
              // Les colonnes de sortie ne se proposent au doigt que si elles ont
              // quelque chose : trois onglets utiles valent mieux que cinq.
              if (count === 0 && CARD_CLOSED_COLUMNS.includes(column)) return null
              return (
                <button
                  key={column}
                  type="button"
                  onClick={() => setVisibleColumn(column)}
                  className={cx(
                    'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    column === visibleColumn
                      ? 'bg-accent-wash text-accent'
                      : 'text-ink-faint hover:text-ink',
                  )}
                >
                  {columnLabel(column)}
                  <span className="text-[0.6875rem] opacity-70">{count}</span>
                </button>
              )
            })}
          </nav>
        ) : null}

        <DndContext
          sensors={sensors}
          // Ni `closestCenter` ni `closestCorners` : une colonne est une grande cible et
          // une carte une petite, et comparer leurs centres fait gagner la colonne
          // alors que le pointeur est posé sur une carte.
          collisionDetection={collisionDetection}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragging(null)}
        >
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
            {shown.map((column) => (
              <BoardColumn
                key={column}
                column={column}
                cards={(layout.get(column) ?? [])
                  .map((id) => byId.get(id))
                  .filter((card) => card !== undefined)}
                projectId={projectId}
                openNumber={openCard?.number ?? null}
                onOpenCard={(card) => showCard(card.number)}
              />
            ))}
          </div>

          {/* La carte suit le pointeur au lieu de se déformer sur place : sans calque,
              le geste ne rend pas ce qu'on tient, seulement un trou à l'origine. */}
          <DragOverlay dropAnimation={null}>
            {held ? <CardTile card={held} overlay /> : null}
          </DragOverlay>
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

function BoardColumn({
  column,
  cards,
  projectId,
  openNumber,
  onOpenCard,
}: {
  column: CardColumn
  cards: CardDto[]
  projectId: string
  openNumber: number | null
  onOpenCard: (card: CardDto) => void
}) {
  const t = useTranslate()
  const createCard = useCreateCard(projectId)
  const [title, setTitle] = useState('')
  const [adding, setAdding] = useState(false)
  // La colonne est elle-même une cible : sans elle, une colonne vide n'aurait aucune
  // carte à survoler et ne pourrait plus rien recevoir.
  const { setNodeRef, isOver } = useDroppable({ id: column })

  const submit = () => {
    const value = title.trim()
    if (!value) return
    createCard.mutate({ title: value, column }, { onSuccess: () => setTitle('') })
  }

  return (
    <section
      className="flex h-full max-h-full w-[17rem] shrink-0 flex-col rounded-lg bg-sunken md:w-72"
      aria-label={columnLabel(column)}
    >
      <header className="flex shrink-0 items-center gap-2 px-2.5 pt-2.5 pb-1.5">
        <h2 className="text-xs font-semibold tracking-wide text-ink-soft uppercase">
          {columnLabel(column)}
        </h2>
        <span className="text-xs text-ink-faint">{cards.length}</span>
        <div className="flex-1" />
        <IconButton label={t('board.card.new')} size="sm" onClick={() => setAdding(true)}>
          <Plus size={14} />
        </IconButton>
      </header>

      <div
        ref={setNodeRef}
        className={cx(
          // Une hauteur minimale même vide : une bande de deux pixels n'est pas une
          // cible qu'on peut viser au pointeur.
          'flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto rounded-md px-2 pb-2 transition-colors',
          isOver && 'bg-accent-wash/40',
        )}
      >
        {adding ? (
          <div className="surface flex flex-col gap-2 rounded-lg border border-line-strong p-2">
            <textarea
              value={title}
              autoFocus
              rows={2}
              placeholder={t('board.card.new.placeholder')}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  submit()
                }
                if (event.key === 'Escape') setAdding(false)
              }}
              className="w-full resize-none bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
            />
            <div className="flex items-center gap-1.5">
              <Button size="sm" disabled={!title.trim() || createCard.isPending} onClick={submit}>
                {t('board.card.add')}
              </Button>
              <IconButton
                label={t('board.card.cancel')}
                size="sm"
                onClick={() => {
                  setAdding(false)
                  setTitle('')
                }}
              >
                <X size={14} />
              </IconButton>
            </div>
          </div>
        ) : null}

        <SortableContext
          items={cards.map((card) => card.id)}
          strategy={verticalListSortingStrategy}
        >
          {cards.map((card) => (
            <CardTile
              key={card.id}
              card={card}
              selected={card.number === openNumber}
              onOpen={() => onOpenCard(card)}
            />
          ))}
        </SortableContext>

        {cards.length === 0 && !adding ? (
          <p className="px-1 py-3 text-center text-xs text-ink-faint">{t('board.column.empty')}</p>
        ) : null}
      </div>
    </section>
  )
}
