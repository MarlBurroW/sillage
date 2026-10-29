import * as Dialog from '@radix-ui/react-dialog'
import { Bot, Combine, MoreHorizontal, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CARD_TAG_COLORS, CARD_TAG_DESCRIPTION_MAX, CARD_TAG_NAME_MAX, type CardTagDto } from '@sillage/protocol'
import { useCardTagSettings, useCardTags, useCreateCardTag, useDeleteCardTag, useMergeCardTag, useUpdateCardTag } from '../../lib/card-tags'
import { useTranslate } from '../../lib/i18n'
import { Banner, Button, ConfirmDialog, IconButton, Menu, MenuItem, MenuLabel, MenuSeparator, MenuSwatch, MenuSwatchRow, Switch } from '../ui'
import { TagChip } from './CardTags'

/**
 * The project's tag catalog in its own window, opened from the board header: renaming, recoloring
 * and describing tags, folding duplicates agents created, and closing the catalog to agents.
 */
export function CardTagsDialog({ projectId, canConfigure, open, onClose }: {
  projectId: string
  /** Project owner: the only one who decides whether agents may create tags. */
  canConfigure: boolean
  open: boolean
  onClose: () => void
}) {
  const t = useTranslate()
  const { data: catalog, isError, error } = useCardTags(open ? projectId : undefined)
  const settings = useCardTagSettings(projectId)
  const create = useCreateCardTag(projectId)
  const [name, setName] = useState('')
  const tags = catalog?.tags ?? []

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-sm" />
        <Dialog.Content aria-describedby={undefined} className="surface fixed inset-x-0 bottom-0 z-50 flex max-h-[95dvh] flex-col rounded-t-2xl border border-line shadow-pop sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[min(600px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl">
          <header className="flex items-center justify-between border-b border-line px-5 py-4">
            <Dialog.Title className="text-lg font-semibold">{t('board.tags.manage')}</Dialog.Title>
            <IconButton label={t('board.panel.close')} onClick={onClose}><X size={18} /></IconButton>
          </header>
          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-5 sm:p-6">
            <div className="flex items-start gap-3 rounded-xl border border-line bg-sunken/50 px-4 py-3">
              <Bot size={16} className="mt-0.5 shrink-0 text-ink-faint" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{t('board.tags.agents')}</p>
                <p className="text-xs leading-relaxed text-ink-faint">
                  {t(canConfigure ? 'board.tags.agents.hint' : 'board.tags.agents.ownerOnly')}
                </p>
              </div>
              <Switch
                checked={catalog?.agentsCanCreate ?? true}
                disabled={!canConfigure || !catalog || settings.isPending}
                label={t('board.tags.agents')}
                onCheckedChange={(agentsCanCreate) => settings.mutate({ agentsCanCreate })}
              />
            </div>

            <form className="flex items-center gap-2" onSubmit={(event) => {
              event.preventDefault()
              if (!name.trim() || create.isPending) return
              create.mutate({ name }, { onSuccess: () => setName('') })
            }}>
              <input
                value={name}
                maxLength={CARD_TAG_NAME_MAX}
                onChange={(event) => setName(event.target.value)}
                aria-label={t('board.tags.new')}
                placeholder={t('board.tags.new')}
                className="tap-target min-w-0 flex-1 rounded-md border border-line bg-sunken px-3 text-sm outline-none placeholder:text-ink-faint focus:border-accent"
              />
              <Button type="submit" size="sm" icon={<Plus size={14} />} disabled={!name.trim()} busy={create.isPending}>{t('board.tags.addTag')}</Button>
            </form>
            {create.isError ? <Banner>{create.error.message}</Banner> : null}
            {isError ? <Banner>{error.message}</Banner> : null}

            {catalog && tags.length === 0 ? <p className="text-sm text-ink-faint">{t('board.tags.none')}</p> : null}
            <ul className="divide-y divide-line">
              {tags.map((tag) => <TagRow key={tag.id} tag={tag} others={tags.filter((other) => other.id !== tag.id)} projectId={projectId} />)}
            </ul>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function TagRow({ tag, others, projectId }: { tag: CardTagDto; others: CardTagDto[]; projectId: string }) {
  const t = useTranslate()
  const update = useUpdateCardTag(projectId)
  const merge = useMergeCardTag(projectId)
  const remove = useDeleteCardTag(projectId)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(tag.name)
  const [description, setDescription] = useState(tag.description)
  const [merging, setMerging] = useState<CardTagDto | null>(null)
  const [deleting, setDeleting] = useState(false)
  const failure = update.error ?? merge.error ?? remove.error

  if (editing) {
    return (
      <li className="py-3">
        <form className="flex flex-col gap-2" onSubmit={(event) => {
          event.preventDefault()
          update.mutate({ id: tag.id, name, description }, { onSuccess: () => setEditing(false) })
        }}>
          <input autoFocus value={name} maxLength={CARD_TAG_NAME_MAX} onChange={(event) => setName(event.target.value)} aria-label={t('board.tags.name')}
            className="tap-target rounded-md border border-line bg-sunken px-3 text-sm outline-none focus:border-accent" />
          <textarea value={description} maxLength={CARD_TAG_DESCRIPTION_MAX} rows={2} onChange={(event) => setDescription(event.target.value)}
            aria-label={t('board.tags.description')} placeholder={t('board.tags.description.placeholder')}
            className="resize-none rounded-md border border-line bg-sunken px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-accent" />
          {update.isError ? <Banner>{update.error.message}</Banner> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(false); setName(tag.name); setDescription(tag.description); update.reset() }}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={!name.trim()} busy={update.isPending}>{t('board.card.save')}</Button>
          </div>
        </form>
      </li>
    )
  }

  return (
    <li className="flex items-start gap-3 py-3">
      <Menu align="start" trigger={
        <button type="button" aria-label={t('board.tags.color', { name: tag.name })}
          className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-surface-high md:size-7 pointer-coarse:size-11">
          <span className="size-3 rounded-full" style={{ backgroundColor: tag.color }} />
        </button>
      }>
        <MenuLabel>{t('board.tags.colorLabel')}</MenuLabel>
        <MenuSwatchRow>
          {CARD_TAG_COLORS.map((color) => (
            <MenuSwatch key={color} color={color} label={color} selected={color.toUpperCase() === tag.color.toUpperCase()}
              onSelect={() => update.mutate({ id: tag.id, color })} />
          ))}
        </MenuSwatchRow>
      </Menu>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <TagChip tag={tag} />
          <span className="text-xs text-ink-faint">{t('board.tags.count', { count: tag.cardCount })}</span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-ink-faint">{tag.description || t('board.tags.noDescription')}</p>
        {tag.createdBy ? (
          <p className="mt-1 flex items-center gap-1 text-[0.6875rem] text-ink-faint">
            <Bot size={11} className="shrink-0" />
            <Link to={`/p/${projectId}/c/${tag.createdBy.conversationId}`} className="truncate hover:text-accent hover:underline">
              {t('board.tags.createdBy', { title: tag.createdBy.title })}
            </Link>
          </p>
        ) : null}
        {failure ? <div className="mt-2"><Banner>{failure.message}</Banner></div> : null}
      </div>
      <IconButton size="sm" label={t('board.tags.editTag', { name: tag.name })} onClick={() => setEditing(true)}><Pencil size={14} /></IconButton>
      <Menu trigger={<IconButton size="sm" label={t('board.tags.actions', { name: tag.name })}><MoreHorizontal size={15} /></IconButton>}>
        {others.length > 0 ? <>
          <MenuLabel>{t('board.tags.mergeInto')}</MenuLabel>
          {others.map((other) => (
            <MenuItem key={other.id} icon={<Combine size={14} />} onSelect={() => setMerging(other)}>{other.name}</MenuItem>
          ))}
          <MenuSeparator />
        </> : null}
        <MenuItem icon={<Trash2 size={14} />} tone="critical" onSelect={() => setDeleting(true)}>{t('board.tags.delete')}</MenuItem>
      </Menu>

      <ConfirmDialog open={merging !== null} onOpenChange={(next) => { if (!next) setMerging(null) }}
        title={t('board.tags.merge.title', { name: tag.name, into: merging?.name ?? '' })}
        confirmLabel={t('board.tags.merge.confirm')} busy={merge.isPending}
        onConfirm={() => merging && merge.mutate({ id: tag.id, into: merging.id }, { onSettled: () => setMerging(null) })}>
        <p>{t('board.tags.merge.body', { name: tag.name, into: merging?.name ?? '', count: tag.cardCount })}</p>
      </ConfirmDialog>
      <ConfirmDialog open={deleting} onOpenChange={setDeleting} tone="critical"
        title={t('board.tags.delete.title', { name: tag.name })} confirmLabel={t('board.tags.delete')} busy={remove.isPending}
        onConfirm={() => remove.mutate(tag.id, { onSettled: () => setDeleting(false) })}>
        <p>{t('board.tags.delete.body', { count: tag.cardCount })}</p>
      </ConfirmDialog>
    </li>
  )
}
