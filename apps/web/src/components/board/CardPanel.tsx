import { ChevronDown, GitBranch, Pencil, Play, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CARD_COLUMNS, type CardColumn, type CardDto } from '@sillage/protocol'
import { restoreCardPanelWidth, setCardPanelWidth } from '../../lib/board-panel'
import { useCardSaving, useDeleteCard, useUpdateCard } from '../../lib/cards'
import { useCardDraft } from '../../lib/card-drafts'
import { useCurrentUser } from '../../lib/session'
import { translate, useTranslate } from '../../lib/i18n'
import { resizeHandle } from '../../lib/resize-handle'
import { useMediaQuery } from '../../lib/viewport'
import { PanelFocus } from '../PanelFocus'
import { Markdown } from '../chat/Markdown'
import { AgentIcon } from '../AgentIcon'
import { Badge, Button, IconButton, Menu, MenuItem, cx } from '../ui'
import { CardNotes } from './CardNotes'
import { COLUMN_TONES, columnLabel } from './columns'

interface CardPanelProps {
  card: CardDto
  projectId: string
  /** État visé, distinct de la présence : le panneau reste monté le temps de sortir. */
  open: boolean
  onClose: () => void
  onSelectCard: (number: number) => void
}

/**
 * Le détail d'une carte, à côté du board plutôt qu'à sa place.
 *
 * Il se pose par-dessus plutôt que de pousser les colonnes, et glisse depuis le bord
 * droit comme le panneau d'outils d'une conversation : c'est le même geste sur le même
 * bord, et deux animations différentes pour deux tiroirs voisins se remarquent.
 */
export function CardPanel({ card, projectId, open, onClose, onSelectCard }: CardPanelProps) {
  const t = useTranslate()
  /**
   * Le premier rendu se fait volontairement hors écran, l'entrée n'étant lancée qu'au
   * rendu suivant : un élément qui naît déjà en place n'a aucune transition à jouer.
   */
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  const aside = useRef<HTMLElement>(null)
  useEffect(restoreCardPanelWidth, [])

  /**
   * Le tiroir est collé au bord droit de la fenêtre : sa largeur vaut donc la distance
   * du pointeur à ce bord, sans décalage à mémoriser au début du geste.
   */
  const handle = resizeHandle({
    widthAt: (clientX) => window.innerWidth - clientX,
    current: () => aside.current?.getBoundingClientRect().width ?? null,
    apply: setCardPanelWidth,
  })

  const navigate = useNavigate()
  const updateCard = useUpdateCard(projectId)
  const deleteCard = useDeleteCard(projectId)
  const saving = useCardSaving(card.id)
  const latestSession = card.conversations.filter((session) => !session.archivedAt)
    .sort((a, b) => b.createdAt - a.createdAt)[0]

  const { data: user } = useCurrentUser()
  const { draft, setDraft, acknowledge } = useCardDraft(user?.id ?? '', card.id)
  const title = draft?.title ?? card.title
  const description = draft?.description ?? card.description
  const descriptionField = useRef<HTMLTextAreaElement>(null)
  const [editing, setEditing] = useState(false)
  const modal = !useMediaQuery('(min-width: 48rem)')
  const editVisible = editing || draft !== null
  useEffect(() => {
    const field = descriptionField.current
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${field.scrollHeight}px`
  }, [description, card.id, editVisible])

  const dirty = title !== card.title || description !== card.description
  // Après un rechargement pendant la requête, le serveur peut déjà avoir reçu
  // le texte. Ne pas laisser ce brouillon masquer ses futures mises à jour.
  useEffect(() => {
    if (draft && !dirty) acknowledge(draft)
  }, [draft, dirty, acknowledge])

  const save = () => {
    if (!title.trim() || !dirty || saving) return
    if (!draft) return
    // La promesse continue même si le panneau est fermé pendant l'enregistrement.
    void updateCard.mutateAsync({ id: card.id, title: title.trim(), description })
      .then(() => { acknowledge(draft); setEditing(false) })
      .catch(() => { /* L'erreur est affichée et le brouillon reste intact. */ })
  }

  return (
    <PanelFocus open={open} modal={modal} onClose={onClose} fallbackFocus={`[data-card-open="${card.id}"], [data-navigation-trigger]`}>
    <aside
      ref={aside}
      inert={!open}
      aria-hidden={!open}
      role={modal ? 'dialog' : 'complementary'}
      aria-modal={modal && open ? true : undefined}
      aria-label={t('board.card.panelLabel', { number: card.number })}
      className={cx(
        // Pas d'`overflow` ici : il rognerait la poignée, posée en débord sur le bord
        // gauche. C'est la zone de défilement interne qui borne le contenu.
        'surface z-20 flex flex-col border-l border-line shadow-pop',
        // `absolute` et non `fixed` : le repère est le calque de la coque, donc le
        // panneau suit le viewport visuel quand le clavier s'ouvre.
        // La largeur est bornée en CSS et pas seulement à l'enregistrement : une
        // fenêtre rétrécie après coup laisserait sinon un tiroir plus large qu'elle.
        'absolute inset-0 md:left-auto md:w-[min(var(--card-panel-width,26rem),calc(100vw-10rem))]',
        // `translate` et non `transform` : Tailwind v4 pose les utilitaires de
        // translation sur cette propriété CSS, distincte de `transform`.
        'transition-[translate] duration-200 ease-out',
        entered && open ? 'translate-x-0' : 'translate-x-full',
      )}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-xs font-medium text-ink-faint">#{card.number}</span>
        <Menu align="start" trigger={
          <button type="button" disabled={saving} aria-label={t('board.card.changeColumn', { column: columnLabel(card.column) })}
            className="flex min-h-11 items-center gap-1 rounded-md px-1 text-ink-faint hover:bg-surface-high md:min-h-9 pointer-coarse:min-h-11">
            <Badge tone={COLUMN_TONES[card.column]}>{columnLabel(card.column)}</Badge>
            <ChevronDown size={13} />
          </button>
        }>
          {CARD_COLUMNS.map((column) => (
            <MenuItem key={column} icon={<span aria-hidden><ColumnDot column={column} /></span>} disabled={column === card.column}
              onSelect={() => updateCard.mutate({ id: card.id, column })}>
              {columnLabel(column)}
            </MenuItem>
          ))}
        </Menu>
        <div className="flex-1" />
        <IconButton data-panel-initial-focus label={t('board.panel.close')} size="sm" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        <div className="flex flex-col gap-2">
          {editVisible ? <>
          <textarea
            autoFocus={editing}
            value={title}
            rows={2}
            aria-label={t('board.card.title')}
            onChange={(event) => setDraft({ title: event.target.value, description })}
            className="w-full resize-none rounded-md border border-transparent bg-transparent px-2 py-1 text-base leading-snug font-semibold text-ink outline-none hover:border-line focus:border-line-strong"
          />
          <textarea
            ref={descriptionField}
            value={description}
            rows={3}
            aria-label={t('board.card.description')}
            placeholder={t('board.card.description.placeholder')}
            onChange={(event) => setDraft({ title, description: event.target.value })}
            className="max-h-[40vh] min-h-24 w-full resize-y rounded-md border border-line bg-sunken px-2.5 py-2 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
          />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={!dirty || !title.trim() || saving} onClick={save}>
                {t(saving ? 'board.card.saving' : 'board.card.save')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => { setDraft(null); setEditing(false) }}
              >
                {t('board.card.cancel')}
              </Button>
              {dirty ? <p className="w-full text-xs text-ink-soft" role="status">{t('board.card.draft')}</p> : null}
            </div>
          </> : <>
            <h2 className="break-words text-lg font-semibold leading-snug text-ink">{card.title}</h2>
            {card.description ? <div className="min-w-0 break-words text-sm text-ink-soft"><Markdown text={card.description} /></div> : null}
            <Button variant="ghost" size="sm" className="self-start" icon={<Pencil size={14} />} onClick={() => setEditing(true)}>
              {t('board.card.edit')}
            </Button>
          </>}
          {updateCard.isError ? <p role="alert" className="text-sm text-critical">{t('board.card.saveError')}</p> : null}
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
          <div className="mt-1 flex flex-wrap gap-2">
            {latestSession ? (
              <Button icon={<Play size={15} />} onClick={() => navigate(`/p/${projectId}/c/${latestSession.id}`)}>
                {t('board.card.resume')}
              </Button>
            ) : null}
            <Button
              variant={latestSession ? 'secondary' : 'primary'}
              icon={latestSession ? <Plus size={15} /> : <Play size={15} />}
              onClick={() => navigate(`/p/${projectId}/c/new?card=${card.id}`)}
            >
              {t(latestSession ? 'board.card.newSession' : 'board.card.launch')}
            </Button>
          </div>
        </div>

        <CardNotes projectId={projectId} cardId={card.id} />

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

      <div className="flex shrink-0 items-center gap-3 border-t border-line px-3 py-2.5">
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

      {/* Poignée de largeur sur le bord gauche, grand écran seulement : au doigt le
          tiroir occupe tout l'écran, il n'y a rien à ajuster. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('board.panel.resize')}
        tabIndex={0}
        onPointerDown={handle.onPointerDown}
        onKeyDown={handle.onKeyDown}
        className={cx(
          'absolute inset-y-0 -left-1 hidden w-2 cursor-col-resize md:block',
          'after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2',
          'after:transition-colors hover:after:bg-accent focus-visible:after:bg-accent',
          'outline-none',
        )}
      />
    </aside>
    </PanelFocus>
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
