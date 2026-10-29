import { Check, Plus, Search, Tag } from 'lucide-react'
import { useState } from 'react'
import { CARD_TAGS_PER_CARD_MAX, cardTagKey, normalizeCardTagName, type CardDto, type CardTagRefDto } from '@sillage/protocol'
import { useCardTags, useCreateCardTag } from '../../lib/card-tags'
import { useUpdateCard } from '../../lib/cards'
import { useTranslate } from '../../lib/i18n'
import { Banner, Button, Popover, cx } from '../ui'

/**
 * A tag as a colored chip. The tint stays light so a row of tags reads as classification rather
 * than competing with the card title; the dot carries the color at full strength.
 */
export function TagChip({ tag, className }: { tag: CardTagRefDto; className?: string }) {
  return (
    <span
      className={cx('inline-flex max-w-40 items-center gap-1 rounded-full px-1.5 py-px text-[0.6875rem] font-medium text-ink-soft', className)}
      style={{ backgroundColor: `color-mix(in oklch, ${tag.color} 16%, transparent)` }}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
      <span className="truncate">{tag.name}</span>
    </span>
  )
}

/**
 * The card's tags with an editor applied on every toggle, like the column menu: tags are a quick
 * classification, a save step would make sorting a board tedious.
 */
export function CardTagsField({ card, projectId }: { card: CardDto; projectId: string }) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  return (
    <section aria-label={t('board.tags.title')} className="flex flex-wrap items-center gap-1.5">
      {card.tags.map((tag) => <TagChip key={tag.id} tag={tag} />)}
      <Popover
        open={open}
        onOpenChange={setOpen}
        side="bottom"
        label={t('board.tags.edit')}
        className="w-72"
        trigger={
          <button
            type="button"
            className="inline-flex min-h-7 items-center gap-1 rounded-full border border-dashed border-line-strong px-2 text-[0.6875rem] text-ink-faint hover:border-accent hover:text-accent pointer-coarse:min-h-11"
          >
            {card.tags.length === 0 ? <Tag size={11} /> : <Plus size={11} />}
            {t(card.tags.length === 0 ? 'board.tags.add' : 'board.tags.edit')}
          </button>
        }
      >
        <TagPicker card={card} projectId={projectId} />
      </Popover>
    </section>
  )
}

function TagPicker({ card, projectId }: { card: CardDto; projectId: string }) {
  const t = useTranslate()
  const { data: catalog } = useCardTags(projectId)
  const update = useUpdateCard(projectId)
  const create = useCreateCardTag(projectId)
  const [query, setQuery] = useState('')
  const name = normalizeCardTagName(query)
  const key = cardTagKey(query)
  const tags = catalog?.tags ?? []
  const shown = key ? tags.filter((tag) => tag.name.toLocaleLowerCase().includes(key)) : tags
  const exact = tags.find((tag) => tag.name.toLocaleLowerCase() === key)
  const selected = new Set(card.tags.map((tag) => tag.id))
  const full = selected.size >= CARD_TAGS_PER_CARD_MAX
  const busy = update.isPending || create.isPending

  const apply = (ids: string[]) => update.mutate({ id: card.id, tagIds: ids })
  const toggle = (id: string) => apply(selected.has(id) ? [...selected].filter((value) => value !== id) : [...selected, id])
  const createAndApply = () => {
    if (!name || exact || full || busy) return
    create.mutate({ name }, {
      onSuccess: (next) => {
        const made = next.tags.find((tag) => tag.name.toLocaleLowerCase() === key)
        if (made) apply([...selected, made.id])
        setQuery('')
      },
    })
  }

  return (
    <div className="flex min-h-0 flex-col">
      <label className="flex items-center gap-2 border-b border-line px-3">
        <Search size={14} className="shrink-0 text-ink-faint" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            if (exact) toggle(exact.id)
            else createAndApply()
          }}
          aria-label={t('board.tags.search')}
          placeholder={t('board.tags.search')}
          className="min-h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-faint"
        />
      </label>
      <ul className="min-h-0 overflow-y-auto p-1" aria-label={t('board.tags.title')}>
        {shown.map((tag) => {
          const checked = selected.has(tag.id)
          return (
            <li key={tag.id}>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                disabled={busy || (!checked && full)}
                onClick={() => toggle(tag.id)}
                title={tag.description || undefined}
                className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-ink-soft hover:bg-surface-high hover:text-ink disabled:opacity-45 pointer-coarse:min-h-11"
              >
                <Check size={13} className={cx('shrink-0 text-accent', !checked && 'invisible')} />
                <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{tag.name}</span>
                  {tag.description ? <span className="block truncate text-xs text-ink-faint">{tag.description}</span> : null}
                </span>
              </button>
            </li>
          )
        })}
        {shown.length === 0 && !name ? <li className="px-2 py-3 text-sm text-ink-faint">{t('board.tags.empty')}</li> : null}
      </ul>
      {name && !exact ? (
        <div className="border-t border-line p-1">
          <Button variant="ghost" size="sm" icon={<Plus size={14} />} disabled={busy || full} onClick={createAndApply} className="w-full justify-start">
            {t('board.tags.create', { name })}
          </Button>
        </div>
      ) : null}
      {full ? <p className="border-t border-line px-3 py-2 text-xs text-ink-faint">{t('board.tags.full', { max: CARD_TAGS_PER_CARD_MAX })}</p> : null}
      {update.isError || create.isError ? <div className="p-2"><Banner>{(update.error ?? create.error)?.message}</Banner></div> : null}
    </div>
  )
}
