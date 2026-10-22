import { Link2, Plus, Search, Unlink } from 'lucide-react'
import { useDeferredValue, useState } from 'react'
import { cardRelationKindSchema, type CardDto, type CardLinkDto, type CardRelationKind } from '@sillage/protocol'
import { useCardRelations, useCardSuggestions, useChangeCardRelation } from '../../lib/cards'
import { useTranslate } from '../../lib/i18n'
import { Badge, Banner, Button, Field, IconButton, Select } from '../ui'
import { COLUMN_TONES, columnLabel } from './columns'

export function CardRelations({ card, projectId, onSelect }: {
  card: CardDto; projectId: string; onSelect: (number: number) => void
}) {
  const t = useTranslate()
  const relations = useCardRelations(card.id)
  const change = useChangeCardRelation(card.id)
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<CardRelationKind>('related')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<CardLinkDto | null>(null)
  const query = useDeferredValue(search.replace(/^#/, '').trim())
  const suggestions = useCardSuggestions(projectId, adding && !selected ? query : null)
  const candidates = suggestions.data?.filter(c => c.id !== card.id) ?? []
  const label = (value: CardRelationKind) => t(`board.relations.${value}`)

  const close = () => { setAdding(false); setSelected(null); setSearch(''); change.reset() }
  return <section aria-label={t('board.relations.title')} className="flex flex-col gap-3 border-t border-line pt-5">
    <div className="flex items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-soft"><Link2 size={15} />{t('board.relations.title')}</h3>
      {!adding ? <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => { change.reset(); setAdding(true) }}>{t('board.relations.add')}</Button> : null}
    </div>
    {relations.isError ? <Banner>{relations.error.message}</Banner> : null}
    {relations.isPending ? <p className="text-xs text-ink-faint">{t('board.relations.loading')}</p> : null}
    {relations.data?.length === 0 && !adding ? <p className="text-sm text-ink-faint">{t('board.relations.empty')}</p> : null}
    {relations.data?.length ? <ul className="divide-y divide-line">
      {relations.data.map(relation => <li key={relation.id} className="flex items-center gap-2 py-2">
        <button type="button" onClick={() => onSelect(relation.card.number)} className="min-w-0 flex-1 rounded-md py-1 text-left hover:text-accent">
          <span className="block text-xs text-ink-faint">{label(relation.kind)}</span>
          <span className="block truncate text-sm">#{relation.card.number} {relation.card.title}</span>
        </button>
        <Badge tone={COLUMN_TONES[relation.card.column]}>{columnLabel(relation.card.column)}</Badge>
        <IconButton size="sm" label={t('board.relations.remove', { number: relation.card.number })} disabled={change.isPending}
          onClick={() => change.mutate({ target: relation.card.number, kind: relation.kind, remove: true })}><Unlink size={14} /></IconButton>
      </li>)}
    </ul> : null}
    {adding ? <form className="flex flex-col gap-3 rounded-lg border border-line p-3" onSubmit={event => {
      event.preventDefault()
      if (!selected || change.isPending) return
      change.mutate({ target: selected.number, kind }, { onSuccess: close })
    }}>
      <Select label={t('board.relations.kind')} value={kind} onChange={setKind} disabled={change.isPending}
        options={cardRelationKindSchema.options.map(value => ({ value, label: label(value) }))} />
      <Field label={t('board.relations.search')} placeholder={t('board.relations.placeholder')} value={search}
        autoFocus icon={<Search size={14} />} disabled={change.isPending}
        onChange={event => { setSearch(event.target.value); setSelected(null) }} />
      {selected ? <p className="text-sm text-accent" aria-label={t('board.relations.selected')}>#{selected.number} {selected.title}</p> :
        <ul aria-label={t('board.relations.results')} className="max-h-48 overflow-y-auto">
          {candidates.map(candidate => <li key={candidate.id}>
            <button type="button" onClick={() => setSelected(candidate)} className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-high">
              <span className="shrink-0 text-ink-faint">#{candidate.number}</span><span className="min-w-0 flex-1 truncate">{candidate.title}</span>
              <span className="shrink-0 text-xs text-ink-faint">{columnLabel(candidate.column)}</span>
            </button>
          </li>)}
          {!suggestions.isFetching && candidates.length === 0 ? <li className="py-2 text-sm text-ink-faint">{t('card.picker.empty')}</li> : null}
        </ul>}
      {suggestions.isError ? <Banner>{suggestions.error.message}</Banner> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={change.isPending} onClick={close}>{t('common.cancel')}</Button>
        <Button type="submit" size="sm" disabled={!selected || change.isPending}>{t('board.relations.save')}</Button>
      </div>
    </form> : null}
    {change.isError ? <Banner>{change.error.message}</Banner> : null}
    <p className="text-xs leading-relaxed text-ink-faint">{t('board.relations.hint')}</p>
  </section>
}
