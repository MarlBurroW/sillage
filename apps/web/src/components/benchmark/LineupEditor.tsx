import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ArrowUpDown, ListPlus, Plus, Undo2 } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { defaultConfigFor, type AgentAvailabilityDto, type AgentConfig, type AgentKind, type ModelListPrice } from '@sillage/protocol'
import {
  anyPriced,
  arrangeRows,
  newRowKey,
  rowTitle,
  rowsEffortsDiffer,
  useLineupFacts,
  type ArrangeKey,
  type LineupRow,
  type MeasuredRows,
} from '../../lib/benchmark-lineup'
import { unavailableReason } from '../../lib/agents'
import { useTranslate, type MessageKey } from '../../lib/i18n'
import { Button, IconButton, Menu, MenuItem, MenuLabel, MenuSeparator } from '../ui'
import { AddModelsDialog } from './AddModelsDialog'
import { BrokenVariantRow, VariantRow, type LockedVariant } from './VariantRow'

const ARRANGE_LABELS: Record<ArrangeKey, MessageKey> = {
  priceAsc: 'benchmark.lineup.arrange.priceAsc',
  priceDesc: 'benchmark.lineup.arrange.priceDesc',
  effortAsc: 'benchmark.lineup.arrange.effortAsc',
  cli: 'benchmark.lineup.arrange.cli',
  name: 'benchmark.lineup.arrange.name',
  reverse: 'benchmark.lineup.arrange.reverse',
  durationAsc: 'benchmark.lineup.arrange.durationAsc',
  costAsc: 'benchmark.lineup.arrange.costAsc',
  ratingAsc: 'benchmark.lineup.arrange.ratingAsc',
}

/** An existing variant's row, with what its runs measured and announced. */
export interface LockedRow extends LockedVariant {
  /**
   * Automatic name the benchmark shows today, written by the server from the model that answered;
   * null when the variant carries a written name, whose automatic one only the server knows.
   */
  automaticTitle: string | null
  model: string | null
  listPrice: ModelListPrice | null
}

/**
 * A lineup as a sortable list of compact rows, one open at a time: the creation form and the
 * dialog that continues a benchmark both edit it. Order is meaning here (it is the order of the
 * tables, the shared page and the slides, and the order runs launch in), so it moves by handle,
 * keyboard or one-shot sorts, each sort undoable.
 */
export function LineupEditor({
  rows,
  onRowsChange,
  expandedKey,
  onExpandedKeyChange,
  maxRows,
  canAdd,
  remaining,
  addLimit,
  defaults,
  firstAgent,
  availability,
  locked,
  removed,
  onRemoveLocked,
  onRestoreLocked,
  measured,
  undo,
  heading,
  toolbar,
}: {
  rows: LineupRow[]
  /** `undo` names the change so the caller can offer to undo it; plain edits pass nothing. */
  onRowsChange: (rows: LineupRow[], undo?: string) => void
  expandedKey: string | null
  onExpandedKeyChange: (key: string | null) => void
  maxRows: number
  /** Whether another variant may be added; `addLimit` says why not. */
  canAdd: boolean
  /** Variants that can still be added at once. */
  remaining: number
  addLimit?: string
  defaults: (agent: AgentKind) => AgentConfig | undefined
  firstAgent: () => AgentKind
  availability: AgentAvailabilityDto[] | undefined
  locked?: Map<string, LockedRow>
  removed?: Set<string>
  onRemoveLocked?: (key: string) => void
  onRestoreLocked?: (key: string) => void
  measured?: MeasuredRows
  undo: { message: string; onUndo: () => void } | null
  heading: ReactNode
  toolbar?: ReactNode
}) {
  const t = useTranslate()
  const [announcement, setAnnouncement] = useState('')
  const [addingModels, setAddingModels] = useState(false)
  const entry = (agent: AgentKind) => availability?.find((item) => item.agent === agent)
  const installed = (agent: AgentKind) => entry(agent)?.installed === true
  const catalogFacts = useLineupFacts(rows, installed)
  // An existing variant is named after what its runs announced, not what its alias means today.
  const facts = useMemo(() => {
    if (!locked) return catalogFacts
    const merged = new Map(catalogFacts)
    for (const [key, info] of locked) {
      const current = merged.get(key)
      if (current) merged.set(key, { ...current, modelId: info.model ?? current.modelId, price: info.listPrice ?? current.price })
    }
    return merged
  }, [catalogFacts, locked])
  const effortsDiffer = rowsEffortsDiffer(rows, facts)
  const fallback = t('composer.select.default')
  const titles = useMemo(() => new Map(rows.map((row) => {
    const info = locked?.get(row.key)
    return [row.key, row.label ?? info?.automaticTitle ?? rowTitle(row, facts.get(row.key), effortsDiffer, fallback)]
  })), [rows, facts, effortsDiffer, locked, fallback])
  const sameAs = useMemo(() => {
    const seen = new Map<string, number>()
    return new Map(rows.map((row, index) => {
      const signature = row.config ? JSON.stringify([row.config, row.label]) : null
      const first = signature === null ? undefined : seen.get(signature)
      if (signature !== null && first === undefined) seen.set(signature, index + 1)
      return [row.key, first ?? null]
    }))
  }, [rows])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const nameOf = (key: unknown) => titles.get(String(key)) ?? String(key)
  const positionOf = (key: unknown) => rows.findIndex((row) => row.key === key) + 1

  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length || from === to) return
    // React moves the DOM node of a row going down, and a moved node loses focus: give it back to
    // the control that asked, so the keyboard way of reordering keeps going step after step.
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const key = rows[from]!.key
    const next = arrayMove(rows, from, to)
    onRowsChange(next)
    setAnnouncement(t('benchmark.lineup.drag.dropped', { name: nameOf(key), position: to + 1, count: rows.length }))
    requestAnimationFrame(() => {
      if (focused?.isConnected && !focused.matches(':disabled')) {
        if (document.activeElement !== focused) focused.focus()
        return
      }
      // At an end of the list the control that moved the row is now disabled and refuses focus:
      // the other move control takes it, else the row's own button, never the page body.
      const row = document.querySelector(`[data-lineup-row="${CSS.escape(key)}"]`)
      ;(row?.querySelector<HTMLElement>('[data-lineup-move]:not(:disabled)') ?? row?.querySelector<HTMLElement>('button[aria-controls]'))?.focus()
    })
  }
  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return
    move(positionOf(event.active.id) - 1, positionOf(event.over.id) - 1)
  }

  const insertAfter = (index: number, row: LineupRow) => {
    const next = [...rows.slice(0, index + 1), row, ...rows.slice(index + 1)]
    onRowsChange(next)
    onExpandedKeyChange(row.key)
  }
  const add = () => {
    // A benchmark usually varies one setting at a time: start from the last row.
    const last = [...rows].reverse().find((row) => row.config)
    const agent = last?.agent ?? firstAgent()
    const config = last?.config ?? defaults(agent) ?? defaultConfigFor(agent)
    // Same model as the row it copies: what was known about it still holds.
    insertAfter(rows.length - 1, { key: newRowKey(), agent: config.agent, config, label: null, known: last?.config === config ? last.known : undefined })
  }
  const duplicate = (index: number) => {
    const source = rows[index]!
    // A copy counts against the same limit as a new row.
    if (!source.config || !canAdd) return
    insertAfter(index, { key: newRowKey(), agent: source.agent, config: source.config, label: null, known: source.known })
  }
  const remove = (index: number) => {
    const row = rows[index]!
    if (locked?.has(row.key)) {
      onRemoveLocked?.(row.key)
      return
    }
    if (expandedKey === row.key) onExpandedKeyChange(null)
    onRowsChange(rows.filter((entry) => entry.key !== row.key), t('benchmark.lineup.removedNamed', { name: titles.get(row.key) ?? '' }))
  }
  const arrange = (key: ArrangeKey) => {
    onExpandedKeyChange(null)
    const how = t(ARRANGE_LABELS[key])
    // The menu item reads as a sentence start; inside "Order: …" it continues one.
    onRowsChange(arrangeRows(rows, facts, key, titles, measured), t('benchmark.lineup.arranged', { how: how.charAt(0).toLocaleLowerCase() + how.slice(1) }))
  }

  const priced = anyPriced(rows, facts)
  const hasMeasures = measured !== undefined && [...measured.values()].some((entry) => entry.durationMs !== null || entry.costUsd !== null || entry.rating !== null)
  const measuredKey = (field: 'durationMs' | 'costUsd' | 'rating') => measured !== undefined && [...measured.values()].some((entry) => entry[field] !== null)
  const live = rows.filter((row) => !removed?.has(row.key)).length

  return (
    <section className="flex min-w-0 flex-col gap-2" data-lineup>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {heading}
        <span className="text-xs text-ink-faint tabular-nums" data-lineup-count>{t('benchmark.lineup.count', { count: live, max: maxRows })}</span>
        <span className="flex-1" />
        {toolbar}
        <Menu
          align="end"
          trigger={<IconButton type="button" size="sm" label={t('benchmark.lineup.arrange')} disabled={rows.length < 2}><ArrowUpDown size={15} /></IconButton>}
        >
          <MenuLabel>{t('benchmark.lineup.arrange.price')}</MenuLabel>
          <MenuItem disabled={!priced} onSelect={() => arrange('priceAsc')}>{t(ARRANGE_LABELS.priceAsc)}</MenuItem>
          <MenuItem disabled={!priced} onSelect={() => arrange('priceDesc')}>{t(ARRANGE_LABELS.priceDesc)}</MenuItem>
          {!priced ? <p className="max-w-60 px-2.5 pb-1.5 text-xs text-ink-faint">{t('benchmark.lineup.arrange.noPrice')}</p> : null}
          <MenuSeparator />
          <MenuItem onSelect={() => arrange('effortAsc')}>{t(ARRANGE_LABELS.effortAsc)}</MenuItem>
          <MenuItem onSelect={() => arrange('cli')}>{t(ARRANGE_LABELS.cli)}</MenuItem>
          <MenuItem onSelect={() => arrange('name')}>{t(ARRANGE_LABELS.name)}</MenuItem>
          <MenuItem onSelect={() => arrange('reverse')}>{t(ARRANGE_LABELS.reverse)}</MenuItem>
          {hasMeasures ? <>
            <MenuSeparator />
            <MenuLabel>{t('benchmark.lineup.arrange.results')}</MenuLabel>
            {measuredKey('rating') ? <MenuItem onSelect={() => arrange('ratingAsc')}>{t(ARRANGE_LABELS.ratingAsc)}</MenuItem> : null}
            {measuredKey('durationMs') ? <MenuItem onSelect={() => arrange('durationAsc')}>{t(ARRANGE_LABELS.durationAsc)}</MenuItem> : null}
            {measuredKey('costUsd') ? <MenuItem onSelect={() => arrange('costAsc')}>{t(ARRANGE_LABELS.costAsc)}</MenuItem> : null}
          </> : null}
        </Menu>
      </div>

      {undo ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-accent-wash px-3 py-1 text-xs text-ink-soft" role="status" data-lineup-undo>
          <span className="min-w-0 flex-1">{undo.message}</span>
          <Button type="button" size="sm" variant="ghost" icon={<Undo2 size={14} />} onClick={undo.onUndo}>{t('benchmark.lineup.undo')}</Button>
        </div>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragStart={() => onExpandedKeyChange(null)}
        onDragEnd={onDragEnd}
        accessibility={{
          screenReaderInstructions: { draggable: t('benchmark.lineup.drag.instructions') },
          announcements: {
            onDragStart: ({ active }) => t('benchmark.lineup.drag.picked', { name: nameOf(active.id) }),
            onDragOver: ({ active, over }) => (over ? t('benchmark.lineup.drag.moved', { name: nameOf(active.id), position: positionOf(over.id), count: rows.length }) : undefined),
            onDragEnd: ({ active, over }) => (over ? t('benchmark.lineup.drag.dropped', { name: nameOf(active.id), position: positionOf(over.id), count: rows.length }) : undefined),
            onDragCancel: ({ active }) => t('benchmark.lineup.drag.cancelled', { name: nameOf(active.id) }),
          },
        }}
      >
        <SortableContext items={rows.map((row) => row.key)} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-line">
            {rows.map((row, index) => {
              const shell = {
                rowKey: row.key,
                index,
                // Moves span every row, struck ones included; removal needs one live row left.
                total: rows.length,
                count: live,
                title: titles.get(row.key) ?? '',
                expanded: expandedKey === row.key,
                onToggle: () => onExpandedKeyChange(expandedKey === row.key ? null : row.key),
                onMove: (delta: -1 | 1) => move(index, index + delta),
                sortable: rows.length > 1,
              }
              if (!row.config) return <BrokenVariantRow key={row.key} shell={shell} agent={row.agent} label={row.label} onRemove={() => remove(index)} />
              const info = locked?.get(row.key)
              return (
                <VariantRow
                  key={row.key}
                  shell={shell}
                  config={row.config}
                  label={row.label}
                  facts={facts.get(row.key)}
                  unavailable={unavailableReason(entry(row.agent))}
                  sameAs={sameAs.get(row.key) ?? null}
                  defaults={defaults}
                  probeModels={installed(row.agent)}
                  locked={info}
                  removed={removed?.has(row.key)}
                  // What the copied benchmark knew describes its model: another model keeps only the catalog's word.
                  onConfigChange={(config) => onRowsChange(rows.map((entry) => (entry.key === row.key ? {
                    ...entry, agent: config.agent, config,
                    known: config.agent === entry.agent && config.model === entry.config?.model ? entry.known : undefined,
                  } : entry)))}
                  onLabelChange={(label) => onRowsChange(rows.map((entry) => (entry.key === row.key ? { ...entry, label } : entry)))}
                  onDuplicate={() => duplicate(index)}
                  duplicateLimit={canAdd ? null : (addLimit ?? null)}
                  onRemove={() => remove(index)}
                  onRestore={() => onRestoreLocked?.(row.key)}
                />
              )
            })}
          </ul>
        </SortableContext>
      </DndContext>
      <p className="sr-only" aria-live="polite">{announcement}</p>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" icon={<Plus size={15} />} disabled={!canAdd} onClick={add}>
          {t('benchmark.form.addVariant')}
        </Button>
        <Button type="button" variant="ghost" size="sm" icon={<ListPlus size={15} />} disabled={!canAdd} onClick={() => setAddingModels(true)}>
          {t('benchmark.lineup.addModels')}
        </Button>
        {/* Written out rather than in a tooltip: disabled buttons take neither focus nor touch. */}
        {!canAdd && addLimit ? <p className="text-xs text-ink-faint" data-lineup-add-limit>{addLimit}</p> : null}
      </div>
      {addingModels ? (
        <AddModelsDialog
          rows={rows}
          availability={availability}
          remaining={remaining}
          defaults={defaults}
          onAdd={(added) => { onRowsChange([...rows, ...added]); setAddingModels(false) }}
          onClose={() => setAddingModels(false)}
        />
      ) : null}
    </section>
  )
}
