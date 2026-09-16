import { Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { CardNoteDto } from '@sillage/protocol'
import { useAddCardNote, useCardNotes, useCardNoteSaving, useDeleteCardNote } from '../../lib/cards'
import { useCardNoteDraft } from '../../lib/card-drafts'
import { useCurrentUser } from '../../lib/session'
import { locale, translate, useTranslate } from '../../lib/i18n'
import { AgentIcon } from '../AgentIcon'
import { Button, IconButton } from '../ui'

/**
 * Le fil d'une carte : ce que les sessions y ont laissé, et ce qu'on y ajoute à la main.
 *
 * Cet écran est ce qui rend l'écriture des agents acceptable. Une note qu'aucun humain
 * ne voit est exactement le magasin de mémoire refusé ailleurs dans la roadmap : elle
 * vieillit sans contradicteur et finit par tromper avec l'autorité d'une note. Ici elle
 * est signée, datée, et se supprime d'un clic.
 */
export function CardNotes({ projectId, cardId }: { projectId: string; cardId: string }) {
  const t = useTranslate()
  const { data: notes, isPending, isError, refetch } = useCardNotes(cardId)
  const ordered = notes ? [...notes].sort((a, b) => b.createdAt - a.createdAt) : []
  const addNote = useAddCardNote(projectId, cardId)
  const saving = useCardNoteSaving(cardId)
  const { data: user } = useCurrentUser()
  const { draft, setDraft, acknowledge } = useCardNoteDraft(user?.id ?? '', cardId)
  const body = draft?.body ?? ''

  const submit = () => {
    if (!draft || !body.trim() || saving) return
    void addNote.mutateAsync(body.trim())
      .then(() => acknowledge(draft))
      .catch(() => { /* Le message d'erreur reste près de la saisie. */ })
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
      {body.trim() ? (
        <>
          <Button size="sm" className="self-start" disabled={saving} onClick={submit}>
            {t(saving ? 'board.card.saving' : 'board.card.notes.add')}
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
        {note.author.kind === 'agent' ? (
          <>
            <AgentIcon agent={note.author.agent} size={11} />
            {/* Le lien tombe avec la conversation supprimée ; la note, elle, reste. */}
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
        <div className="flex-1" />
        <IconButton
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
        </IconButton>
      </div>
      <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-ink-soft">{note.body}</p>
      {remove.isError ? <p role="alert" className="mt-1 text-sm text-critical">{t('board.card.notes.removeError')}</p> : null}
    </li>
  )
}
