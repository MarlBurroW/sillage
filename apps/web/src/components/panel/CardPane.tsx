import { ArrowRightLeft, SquareKanban, Unlink } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useBoardLink } from '../../lib/board-link'
import { useCards } from '../../lib/cards'
import { useTranslate } from '../../lib/i18n'
import { CardDetails } from '../board/CardPanel'
import { Button } from '../ui'
import { PanelEmptyState } from './PanelEmptyState'

/**
 * The conversation's card beside its thread, so the work item stays in view while the agent
 * works on it. Reads the board list rather than a per-card route: the board already polls it and
 * shares its cache, so edits made here and on the board agree.
 */
export function CardPane({ projectId, cardId, onChange, onDetach, detaching = false }: {
  projectId: string
  cardId: string
  /** Owner actions on the session's link; absent for readers, who cannot change it. */
  onChange?: () => void
  onDetach?: () => void
  detaching?: boolean
}) {
  const t = useTranslate()
  const navigate = useNavigate()
  const { data: linkState } = useBoardLink(projectId)
  const link = linkState?.link ?? null
  const { data: cards, isPending } = useCards(projectId, link !== null)
  const card = cards?.find((entry) => entry.id === cardId)

  if (!card) {
    return (
      <PanelEmptyState>
        <SquareKanban size={20} className="text-ink-faint" />
        <p className="text-sm text-ink-faint">{t(isPending ? 'panel.card.loading' : 'panel.card.missing')}</p>
      </PanelEmptyState>
    )
  }
  // Another card cited from here opens on the board: the panel follows this session's card.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {onChange || onDetach ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-3 py-1.5 text-xs text-ink-faint">
          <span className="min-w-0 flex-1 truncate">{t('panel.card.linked')}</span>
          {onChange ? <Button size="sm" variant="ghost" icon={<ArrowRightLeft size={13} />} onClick={onChange}>{t('panel.card.change')}</Button> : null}
          {onDetach ? <Button size="sm" variant="ghost" icon={<Unlink size={13} />} busy={detaching} onClick={onDetach}>{t('conversation.card.detach')}</Button> : null}
        </div>
      ) : null}
      <CardDetails key={card.id} card={card} projectId={projectId} link={link} onSelectCard={(number) => navigate(`/p/${projectId}/board?carte=${number}`)} />
    </div>
  )
}
