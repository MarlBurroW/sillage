import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useState } from 'react'
import { CARD_COLUMNS, type BoardLinkDto, type CardColumn, type CardDto } from '@sillage/protocol'
import { useCreateCard } from '../../lib/cards'
import { useCardDraft } from '../../lib/card-drafts'
import { useCurrentUser } from '../../lib/session'
import { useTranslate } from '../../lib/i18n'
import { Button, ChoiceList, IconButton, Select } from '../ui'
import { CardEditor } from './CardEditor'
import { columnLabel } from './columns'
import { GitHubMark } from './GitHubMark'

export function NewCardDialog({ projectId, link, open, onClose, onCreated }: {
  projectId: string; link: BoardLinkDto | null; open: boolean; onClose: () => void; onCreated: (card: CardDto) => void
}) {
  const t = useTranslate()
  const { data: user } = useCurrentUser()
  const { draft, setDraft, acknowledge } = useCardDraft(user?.id ?? '', `new:${projectId}`)
  const value = draft ?? { title: '', description: '' }
  const [column, setColumn] = useState<CardColumn>('todo')
  // Null : le réglage du board décide. Un choix fait ici vaut pour cette carte seulement.
  const [target, setTarget] = useState<'local' | 'github' | null>(null)
  const where = target ?? link?.newCards ?? 'local'
  const create = useCreateCard(projectId)
  const submit = () => {
    if (!value.title.trim() || create.isPending) return
    create.mutate(
      { ...value, title: value.title.trim(), column, ...(link ? { github: where === 'github' } : {}) },
      { onSuccess: (card) => { acknowledge(value); setTarget(null); onCreated(card) } },
    )
  }
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !create.isPending) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-sm" />
      <Dialog.Content aria-describedby={undefined} className="surface fixed inset-x-0 bottom-0 z-50 flex max-h-[95dvh] flex-col rounded-t-2xl border border-line shadow-pop sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[min(640px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <Dialog.Title className="text-lg font-semibold">{t('board.create.title')}</Dialog.Title>
          <IconButton label={t('board.panel.close')} disabled={create.isPending} onClick={onClose}><X size={18} /></IconButton>
        </header>
        <form className="flex min-h-0 flex-col" onSubmit={(event) => { event.preventDefault(); submit() }}>
          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-5 sm:p-6">
            <CardEditor {...value} onChange={setDraft} disabled={create.isPending} />
            <Select label={t('board.card.column')} value={column} onChange={setColumn} options={CARD_COLUMNS.map((value) => ({ value, label: columnLabel(value) }))} />
            {link ? (
              <ChoiceList
                label={t('board.github.create.where')}
                value={where}
                onChange={setTarget}
                options={[
                  { value: 'local', label: t('board.github.create.local'), hint: t('board.github.create.local.hint') },
                  { value: 'github', label: t('board.github.create.github', { repo: link.repo }), hint: t('board.github.create.github.hint'), icon: <GitHubMark size={14} /> },
                ]}
              />
            ) : null}
            <p className="text-xs text-ink-faint">{t('board.create.filesHint')}</p>
            {create.isError ? <p role="alert" className="text-sm text-critical">{create.error.message}</p> : null}
          </div>
          <footer className="flex justify-end gap-2 border-t border-line px-5 py-4">
            <Button type="button" variant="ghost" disabled={create.isPending} onClick={onClose}>{t('board.card.cancel')}</Button>
            <Button type="submit" disabled={!value.title.trim() || create.isPending}>{t(create.isPending ? 'board.card.saving' : 'board.create.submit')}</Button>
          </footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
