import * as Dialog from '@radix-ui/react-dialog'
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { AgentKind } from '@sillage/protocol'
import { GripVertical, X } from 'lucide-react'
import { useState } from 'react'
import { AGENT_LABELS, AgentIcon } from '../../../apps/web/src/components/AgentIcon'
import { Button, IconButton, Segmented, Switch, cx } from '../../../apps/web/src/components/ui'
import { AGENTS, PRESETS, SPEC, type Entry, type Format, type QuotaOption } from './data'
import { StatusBar } from './StatusBar'

const FORMAT_LABELS: Record<Format, string> = { bar: 'Barre', ring: 'Anneau', text: 'Texte' }

/**
 * One list for every CLI: an item a CLI does not report hides in its sessions. The preview's CLI
 * picker shows what each one will display, so nothing appears or vanishes by surprise.
 */
export function ConfigDialog({ open, onOpenChange, entries, onChange, agent, narrow, clock }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entries: Entry[]
  onChange: (entries: Entry[]) => void
  agent: AgentKind
  narrow: boolean
  clock: number
}) {
  const [previewAgent, setPreviewAgent] = useState<AgentKind>(agent)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const update = (key: string, patch: Partial<Entry>) => onChange(entries.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)))
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const from = entries.findIndex((entry) => entry.key === active.id)
    const to = entries.findIndex((entry) => entry.key === over.id)
    onChange(arrayMove(entries, from, to))
  }

  const absent = entries.filter((entry) => entry.on && SPEC[entry.key].support && !SPEC[entry.key].support!.includes(previewAgent))

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { onOpenChange(next); if (next) setPreviewAgent(agent) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content aria-describedby={undefined}
          className={cx(
            'surface fixed z-50 flex flex-col overflow-hidden border-line shadow-pop',
            'inset-0 border-0',
            'sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-h-[88dvh] sm:w-[min(46rem,94vw)]',
            'sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:border',
          )}>
          <header className="flex shrink-0 items-start gap-2 border-b border-line px-4 py-2.5 pt-[max(0.625rem,var(--sg-safe-top))]">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-sm font-semibold">Barre d’état</Dialog.Title>
              <p className="text-xs text-ink-soft">Pour ton compte, dans toutes tes sessions.</p>
            </div>
            <Dialog.Close asChild><IconButton label="Fermer"><X size={18} /></IconButton></Dialog.Close>
          </header>

          <section aria-label="Aperçu" className="shrink-0 border-b border-line bg-sunken px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="text-xs text-ink-soft">Aperçu pour</span>
              <Segmented label="CLI de l’aperçu" value={previewAgent} onChange={setPreviewAgent}
                options={AGENTS.map((kind) => ({ value: kind, label: AGENT_LABELS[kind], icon: <AgentIcon agent={kind} size={14} /> }))} />
            </div>
            <div className="mt-2 rounded-md border border-line bg-canvas pb-1.5">
              {/* Shown during a turn, so that sub-agents and the clock are visible too. */}
              <StatusBar entries={entries} context={{ agent: previewAgent, scenario: 'running', compact: narrow, clock }}
                onConfigure={() => undefined} onOpen={() => undefined} />
            </div>
            <p className="mt-1.5 text-[0.6875rem] text-ink-faint">
              Pendant un tour.{' '}
              {absent.length > 0
                ? <>Absent de {AGENT_LABELS[previewAgent]} : {absent.map((entry) => SPEC[entry.key].name).join(', ')}.</>
                : <>{AGENT_LABELS[previewAgent]} fournit tout ce que tu as choisi.</>}
            </p>
          </section>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
              <SortableContext items={entries.map((entry) => entry.key)} strategy={verticalListSortingStrategy}>
                <ul className="flex flex-col">
                  {entries.map((entry) => (
                    <Row key={entry.key} entry={entry} previewAgent={previewAgent} narrow={narrow} onChange={(patch) => update(entry.key, patch)} />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          </div>

          <footer className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-2 pb-[max(0.5rem,var(--sg-safe-bottom))]">
            <Button variant="ghost" size="sm" onClick={() => onChange(PRESETS.default.entries)}>Rétablir les défauts</Button>
            <span className="flex-1" />
            <Dialog.Close asChild><Button size="sm">Terminé</Button></Dialog.Close>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Row({ entry, previewAgent, narrow, onChange }: {
  entry: Entry
  previewAgent: AgentKind
  narrow: boolean
  onChange: (patch: Partial<Entry>) => void
}) {
  const spec = SPEC[entry.key]
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: entry.key })
  const missing = spec.support !== null && !spec.support.includes(previewAgent)

  const controls = entry.on && (spec.formats || entry.key === 'quota') ? (
    <div className="flex flex-wrap items-center gap-1.5">
      {spec.formats ? (
        <Segmented label={`Format de ${spec.name}`} value={entry.format ?? spec.formats[0]} onChange={(format) => onChange({ format })}
          options={spec.formats.map((format) => ({ value: format, label: FORMAT_LABELS[format], text: FORMAT_LABELS[format] }))} />
      ) : null}
      {entry.key === 'quota' ? (
        <Segmented<QuotaOption> label="Fenêtres affichées" value={entry.option ?? 'busiest'} onChange={(option) => onChange({ option })}
          options={[{ value: 'busiest', label: 'La plus chargée', text: 'La plus chargée' }, { value: 'all', label: 'Toutes', text: 'Toutes' }]} />
      ) : null}
    </div>
  ) : null

  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx('flex items-start gap-2 rounded-md px-1.5 py-2', isDragging ? 'relative z-10 bg-surface-high shadow-float' : 'hover:bg-surface-high/50')}>
      <button ref={setActivatorNodeRef} type="button" {...attributes} {...listeners} aria-label={`Déplacer ${spec.name}`}
        className="flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-ink-faint hover:text-ink active:cursor-grabbing pointer-coarse:size-11">
        <GripVertical size={15} />
      </button>
      <div className="flex min-h-8 shrink-0 items-center pointer-coarse:min-h-11">
        <Switch checked={entry.on} onCheckedChange={(on) => onChange({ on })} label={`Afficher ${spec.name}`} />
      </div>
      <div className={cx('flex min-w-0 flex-1 gap-x-3 gap-y-1.5', narrow ? 'flex-col' : 'flex-wrap items-center justify-between')}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className={cx('text-sm', entry.on ? 'text-ink' : 'text-ink-soft')}>{spec.name}</span>
            {spec.support ? (
              <span className="flex items-center gap-1" title={`Fourni par ${spec.support.map((kind) => AGENT_LABELS[kind]).join(', ')}`}>
                {spec.support.map((kind) => <span key={kind} className={cx(kind !== previewAgent && 'opacity-60')}><AgentIcon agent={kind} size={11} /></span>)}
              </span>
            ) : null}
            {spec.toBuild ? <span className="rounded-sm border border-dashed border-line-strong px-1 text-[0.625rem] text-ink-faint">à construire</span> : null}
          </div>
          <p className="text-xs text-ink-faint">
            {spec.description}
            {missing && entry.on ? <span className="text-ink-soft"> · absent de {AGENT_LABELS[previewAgent]}</span> : null}
          </p>
        </div>
        {controls}
      </div>
    </li>
  )
}
