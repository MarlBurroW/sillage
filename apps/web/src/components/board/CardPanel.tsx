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
import { CardAttachments } from './CardAttachments'
import { CardEditor } from './CardEditor'
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
  const [editing, setEditing] = useState(false)
  const [tab, setTab] = useState<'details' | 'activity' | 'sessions'>('details')
  const modal = !useMediaQuery('(min-width: 48rem)')
  const editVisible = editing || draft !== null

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
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && editVisible) {
          event.preventDefault()
          save()
        }
      }}
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
        'absolute inset-0 md:left-auto md:w-[min(var(--card-panel-width,40rem),calc(100vw-10rem))]',
        // `translate` et non `transform` : Tailwind v4 pose les utilitaires de
        // translation sur cette propriété CSS, distincte de `transform`.
        'transition-[translate] duration-200 ease-out',
        entered && open ? 'translate-x-0' : 'translate-x-full',
      )}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
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

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-sunken/50 px-5 py-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{card.title}</span>
        {latestSession ? <Button size="sm" variant="secondary" icon={<Play size={14} />} onClick={() => navigate(`/p/${projectId}/c/${latestSession.id}`)}>{t('board.card.resume')}</Button> : null}
        <Button size="sm" disabled={dirty || saving} title={dirty ? t('board.editor.saveBeforeLaunch') : undefined} icon={<Plus size={14} />} onClick={() => navigate(`/p/${projectId}/c/new?card=${card.id}`)}>
          {t(latestSession ? 'board.card.newSession' : 'board.card.launch')}
        </Button>
        {dirty ? <p className="w-full text-xs text-ink-faint">{t('board.editor.saveBeforeLaunch')}</p> : null}
      </div>
      <nav aria-label={t('board.card.sections')} className="flex shrink-0 gap-5 border-b border-line px-5">
        {(['details', 'activity', 'sessions'] as const).map((value) => <button type="button" key={value} aria-pressed={tab === value} onClick={() => setTab(value)}
          className={cx('flex min-h-12 items-center gap-2 border-b-2 text-sm font-medium transition-colors', tab === value ? 'border-accent text-accent' : 'border-transparent text-ink-faint hover:text-ink')}>
          {t(value === 'details' ? 'board.card.details' : value === 'activity' ? 'board.card.activity' : 'board.card.sessions.title')}
          {value !== 'details' ? <span className="rounded-md bg-sunken px-1.5 py-0.5 text-xs">{value === 'activity' ? card.noteCount : card.conversations.length}</span> : null}
        </button>)}
      </nav>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5 sm:p-6">
        {tab === 'details' ? <>
        <div className="flex flex-col gap-4">
          {editVisible ? <CardEditor title={title} description={description} onChange={setDraft} /> : <>
            <div className="flex flex-col items-start gap-3 sm:flex-row">
              <h2 className="min-w-0 flex-1 break-words text-2xl font-semibold leading-snug tracking-tight text-ink">{card.title}</h2>
              <Button variant="secondary" size="sm" icon={<Pencil size={14} />} onClick={() => setEditing(true)}>{t('board.card.edit')}</Button>
            </div>
            <div className="rounded-xl border border-line p-4">
              <h3 className="mb-3 text-sm font-semibold text-ink-soft">{t('board.card.description')}</h3>
              {card.description ? <div className="min-w-0 break-words text-sm leading-relaxed text-ink-soft"><Markdown text={card.description} /></div> :
                <button type="button" onClick={() => setEditing(true)} className="w-full py-6 text-left text-sm text-ink-faint hover:text-accent">{t('board.editor.addDescription')}</button>}
            </div>
          </>}
          {updateCard.isError ? <p role="alert" className="text-sm text-critical">{t('board.card.saveError')}</p> : null}
        </div>
        <CardAttachments key={card.id} cardId={card.id} projectId={projectId} />
        <CardLinkList title={t('board.card.references')} links={card.references} onSelect={onSelectCard} />
        <CardLinkList title={t('board.card.referencedBy')} links={card.referencedBy} onSelect={onSelectCard} />
        </> : null}
        {tab === 'activity' ? <CardNotes projectId={projectId} cardId={card.id} /> : null}
        {tab === 'sessions' ? (
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
        </div>
        ) : null}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-sunken/40 px-5 py-3">
        {editVisible ? <>
          <p className="min-w-0 flex-1 text-xs text-ink-faint" role="status">{t(dirty ? 'board.card.draft' : 'board.editor.saved')}</p>
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => { setDraft(null); setEditing(false) }}>{t('board.card.cancel')}</Button>
          <Button size="sm" disabled={!dirty || !title.trim() || saving} onClick={save}>{t(saving ? 'board.card.saving' : 'board.card.save')}</Button>
        </> : <>
          <p className="min-w-0 flex-1 text-xs text-ink-faint">{t('board.card.author', { name: card.createdByName })}</p>
          <IconButton label={t('board.card.remove')} size="sm" disabled={deleteCard.isPending} onClick={() => {
            if (!confirm(translate('board.card.remove.confirm', { number: card.number }))) return
            deleteCard.mutate(card.id, { onSuccess: onClose })
          }}><Trash2 size={15} /></IconButton>
        </>}
        {deleteCard.isError ? <p role="alert" className="w-full text-sm text-critical">{t('board.files.error')}</p> : null}
      </footer>

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
