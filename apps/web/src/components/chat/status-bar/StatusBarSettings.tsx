import * as Dialog from '@radix-ui/react-dialog'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type KeyboardCoordinateGetter } from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, X } from 'lucide-react'
import { useState } from 'react'
import { agentKindSchema, type AgentKind, type StatusBarFormat, type StatusBarWindows } from '@sillage/protocol'
import { AGENT_LABELS, AgentIcon } from '../../AgentIcon'
import { Button, IconButton, Segmented, Switch, cx } from '../../ui'
import { useTranslate } from '../../../lib/i18n'
import { statusItemSpec, useStatusBar, type StatusItem, type StatusItemKey } from '../../../lib/status-bar'
import type { StatusData } from '../../../lib/status-data'
import { quotaWindowLabel } from '../../../lib/usage'
import { useMediaQuery } from '../../../lib/viewport'
import { StatusBar } from './StatusBar'

const AGENTS = agentKindSchema.options
const MINUTE = 60_000

/**
 * dnd-kit's arrow keys put the moving row's edge on its target's edge. Rows here differ in height
 * (format controls stack under the name on phones), and the moving row's centre then lands nearer
 * the row beyond, so one press skipped a place. Centring it on the target keeps one press, one place.
 */
const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  const next = sortableKeyboardCoordinates(event, args)
  const moving = args.context.collisionRect
  if (!next || !moving) return next
  for (const target of args.context.droppableRects.values()) {
    if (target.left === next.x && (target.top === next.y || target.top + target.height === next.y + moving.height)) {
      return { x: next.x, y: target.top + target.height / 2 - moving.height / 2 }
    }
  }
  return next
}

/**
 * Sample values for the preview, one set per CLI, as during a turn so that running agents and the
 * clock show too. Live values only exist for the open session's CLI; the preview must show the
 * others as well, and keeps what each CLI does not report empty, as a session would.
 */
function sampleData(agent: AgentKind, now: number): StatusData {
  const windows = {
    claude: [
      { id: 'five_hour', label: 'five_hour', utilization: 0.42, resetsAt: now + 80 * MINUTE },
      { id: 'seven_day', label: 'seven_day', utilization: 0.18, resetsAt: now + 76 * 60 * MINUTE },
      { id: 'seven_day_opus', label: 'seven_day_opus', utilization: 0.31, resetsAt: now + 76 * 60 * MINUTE },
    ],
    codex: [
      { id: 'codex:primary', label: '5 h', utilization: 0.27, resetsAt: now + 190 * MINUTE },
      { id: 'codex:secondary', label: quotaWindowLabel('seven_day'), utilization: 0.55, resetsAt: now + 4 * 24 * 60 * MINUTE },
    ],
    copilot: [{ id: 'premium_interactions', label: 'Premium', utilization: 0.64, resetsAt: now + 12 * 24 * 60 * MINUTE }],
    grok: [{ id: 'credits', label: quotaWindowLabel('seven_day'), utilization: 0.12, resetsAt: now + 5 * 24 * 60 * MINUTE }],
    antigravity: [{ id: 'pro', label: 'Gemini Pro', utilization: 0.4, resetsAt: null }],
    opencode: [],
  }[agent]
  const models = { claude: 'claude-opus-5-5', codex: 'gpt-5.5-codex', copilot: 'claude-sonnet-5.5', opencode: 'anthropic/claude-sonnet-5-5', grok: 'grok-build', antigravity: 'gemini-3-pro' }
  const reports = (key: StatusItemKey) => statusItemSpec(key).agents?.includes(agent) ?? true
  return {
    agent,
    warm: true,
    windows,
    context: { usedTokens: 58_000, maxTokens: 200_000, ratio: 0.29 },
    tokens: { input: 18_400, output: 41_200, cacheWrite: 96_000, cacheRead: 1_062_000 },
    lastTurnTokens: 85_300,
    costUsd: 4.12,
    subAgents: reports('agents') ? ['Explore', 'Explore', 'Plan'] : [],
    background: [],
    turnStartedAt: now - 134_000,
    model: models[agent],
    cliVersion: reports('version') ? '2.1.332' : null,
    versionGap: null,
    worktree: null,
    files: 7,
    tools: { calls: 84, errors: 2 },
    previews: [{ port: 5173, title: null }],
  }
}

/**
 * The status line's settings: one sortable list for every CLI, and a preview whose CLI picker
 * shows what each one will display, so nothing appears or vanishes by surprise. Changes apply at
 * once, like the composer's pins.
 */
export function StatusBarSettings({ open, onOpenChange, agent }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The open session's CLI, previewed first. */
  agent: AgentKind
}) {
  const t = useTranslate()
  const { items, save } = useStatusBar()
  const [previewAgent, setPreviewAgent] = useState<AgentKind>(agent)
  const [now] = useState(() => Date.now())
  const narrow = useMediaQuery('(max-width: 639px)')
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }),
  )
  const name = (key: unknown) => t(`statusBar.item.${key as StatusItemKey}.name`)
  const position = (key: unknown) => items.findIndex((item) => item.key === key) + 1
  const update = (key: StatusItemKey, patch: Partial<StatusItem>) => save(items.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    save(arrayMove(items, position(active.id) - 1, position(over.id) - 1))
  }
  const absent = items.filter((item) => item.on && !(statusItemSpec(item.key).agents?.includes(previewAgent) ?? true))

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (next) setPreviewAgent(agent); onOpenChange(next) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content aria-describedby={undefined}
          className={cx(
            'surface fixed z-50 flex flex-col overflow-hidden border-line shadow-pop',
            'inset-0 border-0',
            'sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-h-[88dvh] sm:w-[min(46rem,94vw)]',
            'sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:border',
          )}>
          <header className="flex shrink-0 items-start gap-2 border-b border-line py-1.5 pr-1 pl-4 pt-[max(0.375rem,var(--sg-safe-top))]">
            <div className="min-w-0 flex-1 py-1">
              <Dialog.Title className="text-sm font-semibold">{t('statusBar.settings.title')}</Dialog.Title>
              <p className="text-xs text-ink-soft">{t('statusBar.settings.scope')}</p>
            </div>
            <Dialog.Close asChild><IconButton label={t('common.close')}><X size={18} /></IconButton></Dialog.Close>
          </header>

          <section aria-label={t('statusBar.settings.previewFor')} className="shrink-0 border-b border-line bg-sunken px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="text-xs text-ink-soft">{t('statusBar.settings.previewFor')}</span>
              <Segmented label={t('statusBar.settings.previewAgent')} value={previewAgent} onChange={setPreviewAgent}
                options={AGENTS.map((kind) => ({ value: kind, label: AGENT_LABELS[kind], icon: <AgentIcon agent={kind} size={14} /> }))} />
            </div>
            <div className="mt-2 rounded-md border border-line bg-canvas px-1 pb-1" data-status-preview>
              <StatusBar items={items} data={sampleData(previewAgent, now)} onConfigure={() => undefined} onOpen={() => undefined} preview />
            </div>
            <p className="mt-1.5 text-[0.6875rem] text-ink-faint">
              {t('statusBar.settings.sample')}{' '}
              {absent.length > 0
                ? t('statusBar.settings.absent', { agent: AGENT_LABELS[previewAgent], items: absent.map((item) => name(item.key)).join(', ') })
                : t('statusBar.settings.complete', { agent: AGENT_LABELS[previewAgent] })}
            </p>
          </section>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
            <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis, restrictToParentElement]} onDragEnd={onDragEnd}
              accessibility={{
                screenReaderInstructions: { draggable: t('statusBar.settings.reorderInstructions') },
                announcements: {
                  onDragStart: ({ active }) => t('composer.settings.reorder.picked', { setting: name(active.id) }),
                  onDragOver: ({ active, over }) => over ? t('composer.settings.reorder.moved', { setting: name(active.id), position: String(position(over.id)) }) : undefined,
                  onDragEnd: ({ active, over }) => over ? t('composer.settings.reorder.dropped', { setting: name(active.id), position: String(position(over.id)) }) : undefined,
                  onDragCancel: ({ active }) => t('composer.settings.reorder.cancelled', { setting: name(active.id) }),
                },
              }}>
              <SortableContext items={items.map((item) => item.key)} strategy={verticalListSortingStrategy}>
                <ul className="flex flex-col">
                  {items.map((item) => (
                    <ItemRow key={item.key} item={item} previewAgent={previewAgent} narrow={narrow} onChange={(patch) => update(item.key, patch)} />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          </div>

          <footer className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-2 pb-[max(0.5rem,var(--sg-safe-bottom))]">
            <Button variant="ghost" size="sm" onClick={() => save(null)}>{t('statusBar.settings.reset')}</Button>
            <span className="flex-1" />
            <Dialog.Close asChild><Button size="sm">{t('statusBar.settings.done')}</Button></Dialog.Close>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ItemRow({ item, previewAgent, narrow, onChange }: {
  item: StatusItem
  previewAgent: AgentKind
  narrow: boolean
  onChange: (patch: Partial<StatusItem>) => void
}) {
  const t = useTranslate()
  const spec = statusItemSpec(item.key)
  const name = t(`statusBar.item.${item.key}.name`)
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.key })
  const missing = spec.agents !== null && !spec.agents.includes(previewAgent)

  const controls = item.on && spec.formats ? (
    <div className="flex flex-wrap items-center gap-1.5">
      <Segmented<StatusBarFormat> label={t('statusBar.settings.format', { item: name })} value={item.format ?? spec.formats[0]!} onChange={(format) => onChange({ format })}
        options={spec.formats.map((format) => ({ value: format, label: t(`statusBar.format.${format}`), text: t(`statusBar.format.${format}`) }))} />
      {item.key === 'quota' ? (
        <Segmented<StatusBarWindows> label={t('statusBar.windows.label')} value={item.windows} onChange={(windows) => onChange({ windows })}
          options={[
            { value: 'busiest', label: t('statusBar.windows.busiest'), text: t('statusBar.windows.busiest') },
            { value: 'all', label: t('statusBar.windows.all'), text: t('statusBar.windows.all') },
          ]} />
      ) : null}
    </div>
  ) : null

  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} data-status-item={item.key}
      className={cx('relative flex items-start gap-1 rounded-md py-1.5 pr-1.5', isDragging ? 'z-10 bg-surface shadow-pop' : 'hover:bg-surface-high/50')}>
      {/* Only the handle starts a drag: touch scrolling stays possible over the rest of the row. */}
      <button ref={setActivatorNodeRef} type="button" {...attributes} {...listeners} aria-label={t('statusBar.settings.move', { item: name })}
        className="flex h-11 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-ink-faint hover:bg-surface-high hover:text-ink focus-visible:outline-2 focus-visible:outline-accent active:cursor-grabbing">
        <GripVertical size={16} />
      </button>
      <div className="flex h-11 shrink-0 items-center pr-1.5">
        <Switch checked={item.on} onCheckedChange={(on) => onChange({ on })} label={t('statusBar.settings.show', { item: name })} />
      </div>
      <div className={cx('flex min-w-0 flex-1 gap-x-3 gap-y-1.5 py-1.5', narrow ? 'flex-col' : 'flex-wrap items-center justify-between')}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className={cx('text-sm', item.on ? 'text-ink' : 'text-ink-soft')}>{name}</span>
            {spec.agents ? (
              <span className="flex items-center gap-1" title={t('statusBar.settings.reportedBy', { agents: spec.agents.map((kind) => AGENT_LABELS[kind]).join(', ') })}>
                {spec.agents.map((kind) => <span key={kind} className={cx('inline-flex', kind !== previewAgent && 'opacity-60')}><AgentIcon agent={kind} size={11} /></span>)}
              </span>
            ) : null}
          </div>
          <p className="text-xs text-ink-faint">
            {t(`statusBar.item.${item.key}.description`)}
            {missing && item.on ? <span className="text-ink-soft"> · {t('statusBar.settings.missing', { agent: AGENT_LABELS[previewAgent] })}</span> : null}
          </p>
        </div>
        {controls}
      </div>
    </li>
  )
}
