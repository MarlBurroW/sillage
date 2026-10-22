import { AlertTriangle, ExternalLink, Loader2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { CardExternalDto, CardNoteDto } from '@sillage/protocol'
import { useAddCardNote, useCardNotes, useCardNoteSaving, useDeleteCardNote } from '../../lib/cards'
import { useCardNoteDraft } from '../../lib/card-drafts'
import { useCurrentUser } from '../../lib/session'
import { locale, translate, translateError, useTranslate } from '../../lib/i18n'
import { AgentIcon } from '../AgentIcon'
import { Button, IconButton } from '../ui'
import { GitHubMark } from './GitHubMark'

/**
 * Card thread holds session notes and human additions. Visible, attributed, dated,
 * one-click-deletable notes make agent writing accountable, unlike hidden memory stores whose
 * unchecked aging content can acquire misleading authority.
 */
export function CardNotes({
  projectId,
  cardId,
  issue = null,
}: {
  projectId: string
  cardId: string
  /** Tracked issue whose comments arrive here and can receive notes. */
  issue?: CardExternalDto | null
}) {
  const t = useTranslate()
  const { data: notes, isPending, isError, refetch } = useCardNotes(cardId, issue !== null)
  // Reset unchecked: public publication must be deliberate rather than habitual.
  const [publish, setPublish] = useState(false)
  const ordered = notes ? [...notes].sort((a, b) => b.createdAt - a.createdAt) : []
  const addNote = useAddCardNote(projectId, cardId)
  const saving = useCardNoteSaving(cardId)
  const { data: user } = useCurrentUser()
  const { draft, setDraft, acknowledge } = useCardNoteDraft(user?.id ?? '', cardId)
  const body = draft?.body ?? ''

  const submit = () => {
    if (!draft || !body.trim() || saving) return
    void addNote.mutateAsync({ body: body.trim(), publish: issue !== null && publish })
      .then(() => { acknowledge(draft); setPublish(false) })
      .catch(() => { /* Keep errors close to input. */ })
  }

  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-ink-faint uppercase">
        {t('board.card.notes.title')}
      </h3>

      {isPending ? <p className="text-sm text-ink-faint">{t('board.card.notes.loading')}</p> : isError ? (
        <div role="alert">
          <p className="text-sm text-critical">{t('board.card.notes.loadError')}</p>
          <Button variant="ghost" size="sm" onClick={() => void refetch()}>{t('agent.install.retry')}</Button>
        </div>
      ) : ordered[0] ? (
        <>
          <ul><Note note={ordered[0]} projectId={projectId} cardId={cardId} /></ul>
          {ordered.length > 1 ? (
            <details className="text-sm text-ink-soft">
              <summary className="cursor-pointer py-2">{t('board.card.notes.older', { count: ordered.length - 1 })}</summary>
              <ul className="flex flex-col gap-2">
                {ordered.slice(1).map((note) => <Note key={note.id} note={note} projectId={projectId} cardId={cardId} />)}
              </ul>
            </details>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-ink-faint">{t('board.card.notes.none')}</p>
      )}

      <textarea
        value={body}
        rows={2}
        aria-label={t('board.card.notes.add')}
        placeholder={t('board.card.notes.placeholder')}
        maxLength={8000}
        onChange={(event) => setDraft(event.target.value ? { body: event.target.value } : null)}
        className="mt-1 w-full resize-y rounded-md border border-line bg-sunken px-2.5 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
      />
      {issue ? (
        <label className="flex items-start gap-2 text-xs text-ink-soft">
          <input type="checkbox" className="mt-0.5" checked={publish} onChange={(event) => setPublish(event.target.checked)} />
          <span>
            <span className="inline-flex items-center gap-1"><GitHubMark size={11} />{t('board.github.notes.publish', { number: issue.number })}</span>
            <span className="block text-ink-faint">{t('board.github.notes.publishHint')}</span>
          </span>
        </label>
      ) : null}
      {body.trim() ? (
        <>
          <Button size="sm" className="self-start" disabled={saving} onClick={submit}>
            {t(saving ? 'board.card.saving' : issue && publish ? 'board.github.notes.addAndPublish' : 'board.card.notes.add')}
          </Button>
          <p className="text-xs text-ink-faint">{t('board.card.notes.draft')}</p>
        </>
      ) : null}
      {addNote.isError ? <p role="alert" className="text-sm text-critical">{t('board.card.notes.saveError')}</p> : null}
    </div>
  )
}

function Note({
  note,
  projectId,
  cardId,
}: {
  note: CardNoteDto
  projectId: string
  cardId: string
}) {
  const t = useTranslate()
  const remove = useDeleteCardNote(projectId, cardId)

  const when = new Date(note.createdAt).toLocaleString(locale(), {
    dateStyle: 'short',
    timeStyle: 'short',
  })

  return (
    <li
      className="group/note rounded-md border border-line bg-sunken px-2.5 py-2"
    >
      <div className="flex items-center gap-1.5 text-[0.6875rem] text-ink-faint">
        {note.author.kind === 'github' ? (
          <>
            <GitHubMark size={11} />
            {note.externalUrl ? (
              <a href={note.externalUrl} target="_blank" rel="noreferrer" className="min-w-0 truncate font-medium hover:text-ink">@{note.author.login}</a>
            ) : (
              <span className="min-w-0 truncate font-medium">@{note.author.login}</span>
            )}
          </>
        ) : note.author.kind === 'agent' ? (
          <>
            <AgentIcon agent={note.author.agent} size={11} />
            {/* Deleted conversations remove links but leave notes. */}
            {note.author.conversationId ? (
              <Link
                to={`/p/${projectId}/c/${note.author.conversationId}`}
                className="min-w-0 truncate hover:text-ink"
              >
                {note.author.conversationTitle}
              </Link>
            ) : (
              <span className="min-w-0 truncate">{t('board.card.notes.goneSession')}</span>
            )}
          </>
        ) : (
          <span className="min-w-0 truncate">{note.author.name}</span>
        )}
        <span aria-hidden>·</span>
        <span className="shrink-0">{when}</span>
        <Publication note={note} />
        <div className="flex-1" />
        {/* Delete GitHub content there; local-only deletion would return on sync. */}
        {note.externalUrl ? null : <IconButton
          label={t('board.card.notes.remove')}
          size="sm"
          className="opacity-0 group-hover/note:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
          disabled={remove.isPending}
          onClick={() => {
            if (!confirm(translate('board.card.notes.removeConfirm'))) return
            remove.mutate(note.id)
          }}
        >
          <Trash2 size={13} />
        </IconButton>}
      </div>
      <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-ink-soft">{note.body}</p>
      {remove.isError ? <p role="alert" className="mt-1 text-sm text-critical">{t('board.card.notes.removeError')}</p> : null}
    </li>
  )
}

/** GitHub note state: delivered with link, pending, or rejected with reason. */
function Publication({ note }: { note: CardNoteDto }) {
  const t = useTranslate()
  if (note.publication === 'published') {
    return note.externalUrl ? (
      <a href={note.externalUrl} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-positive hover:underline">
        <GitHubMark size={10} />
        {t('board.github.notes.published')}
        <ExternalLink size={10} />
      </a>
    ) : null
  }
  if (note.publication === 'pending') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1">
        <Loader2 size={10} className="animate-spin" />
        {t('board.github.notes.pending')}
      </span>
    )
  }
  if (note.publication === 'failed') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-critical" title={note.publicationError ? translateError(note.publicationError, '') : undefined}>
        <AlertTriangle size={10} />
        {t('board.github.notes.failed')}
      </span>
    )
  }
  return null
}
