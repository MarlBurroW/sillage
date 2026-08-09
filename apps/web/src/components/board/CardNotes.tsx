import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { CardNoteDto } from '@sillage/protocol'
import { useAddCardNote, useCardNotes, useDeleteCardNote } from '../../lib/cards'
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
  const { data: notes } = useCardNotes(cardId)
  const addNote = useAddCardNote(projectId, cardId)
  const [draft, setDraft] = useState('')

  const submit = () => {
    const body = draft.trim()
    if (!body) return
    addNote.mutate(body, { onSuccess: () => setDraft('') })
  }

  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-ink-faint uppercase">
        {t('board.card.notes.title')}
      </h3>

      {notes && notes.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {notes.map((note) => (
            <Note key={note.id} note={note} projectId={projectId} cardId={cardId} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-faint">{t('board.card.notes.none')}</p>
      )}

      <textarea
        value={draft}
        rows={2}
        aria-label={t('board.card.notes.add')}
        placeholder={t('board.card.notes.placeholder')}
        onChange={(event) => setDraft(event.target.value)}
        className="mt-1 w-full resize-y rounded-md border border-line bg-sunken px-2.5 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
      />
      {draft.trim() ? (
        <Button size="sm" className="self-start" disabled={addNote.isPending} onClick={submit}>
          {t('board.card.notes.add')}
        </Button>
      ) : null}
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
          className="opacity-0 group-hover/note:opacity-100 focus-visible:opacity-100"
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
    </li>
  )
}
