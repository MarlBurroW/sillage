import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDown, ArrowUp, ChevronDown, Copy, CopyPlus, Equal, GripVertical, Hourglass, Info, OctagonAlert, Trash2, TriangleAlert, Undo2 } from 'lucide-react'
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { AgentConfig, AgentKind, BenchmarkRunDto, ModelListPrice } from '@sillage/protocol'
import { type LineupFacts, formatListPrice } from '../../lib/benchmark-lineup'
import { RUN_STATUS_LABELS, RUN_TONES } from '../../lib/benchmarks'
import { locale, useTranslate } from '../../lib/i18n'
import { useMediaQuery } from '../../lib/viewport'
import { AGENT_LABELS, AgentIcon } from '../AgentIcon'
import { useAgentSettings } from '../chat/agent-settings'
import { Button, Field, IconButton, Popover, cx } from '../ui'
import { Tooltip } from '../ui/Tooltip'
import { VariantFields } from './VariantEditor'

/** What an existing variant of a benchmark brings to its row: it ran, so its settings are frozen. */
export interface LockedVariant {
  runs: BenchmarkRunDto[]
  cliVersion: string | null
  /** Exact model and effort, for the second line and the tooltip. */
  technicalLabel: string
  /** `running`: a run is under way, so the server refuses the removal. */
  removal: 'free' | 'confirm' | 'running'
}

interface RowShell {
  rowKey: string
  index: number
  /** Rows in the list, struck ones included: the bounds of a move. */
  total: number
  /** Live rows: the last one cannot be removed. */
  count: number
  title: string
  expanded: boolean
  onToggle: () => void
  onMove: (delta: -1 | 1) => void
  sortable: boolean
}

/** Drag handle, ordinal and frame shared by every kind of row. Only the handle starts a drag, so selects and touch scrolling keep working. */
function SortableShell({ rowKey, index, sortable, expanded, removed, children }: {
  rowKey: string
  index: number
  sortable: boolean
  expanded: boolean
  removed?: boolean
  children: (handle: ReactNode) => ReactNode
}) {
  const t = useTranslate()
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: rowKey, disabled: !sortable })
  const handle = sortable ? (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      aria-label={t('benchmark.lineup.drag', { position: index + 1 })}
      className="flex h-11 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-ink-faint hover:bg-surface-high hover:text-ink focus-visible:outline-2 focus-visible:outline-accent active:cursor-grabbing md:h-9 pointer-coarse:h-11"
    >
      <GripVertical size={15} />
    </button>
  ) : <span aria-hidden className="w-7 shrink-0" />
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx('relative bg-surface', isDragging && 'z-10 shadow-pop', expanded && 'bg-sunken/40', removed && 'bg-critical/5')}
      data-benchmark-variant
      data-lineup-row={rowKey}
    >
      {children(handle)}
    </li>
  )
}

/**
 * "$2 / $10" with the public-price explanation on hover, or "no price" when the lists do not know
 * the model. Not focusable: it sits inside the row's toggle button, and its text already reads.
 */
export function PriceTag({ price }: { price: ModelListPrice | null }) {
  const t = useTranslate()
  return (
    <Tooltip label={price ? t('benchmark.lineup.price.hint') : t('benchmark.lineup.price.none')}>
      <span className="shrink-0 tabular-nums" data-lineup-price={price ? `${price.input}/${price.output}` : 'none'}>
        {price ? formatListPrice(price, locale()) : t('benchmark.lineup.price.unknown')}
      </span>
    </Tooltip>
  )
}

function Marker({ tone, label, children }: { tone: 'critical' | 'caution'; label: string; children: ReactNode }) {
  return (
    <Tooltip label={label}>
      <span tabIndex={0} role="img" aria-label={label} className={cx('inline-flex shrink-0 items-center gap-1 rounded-sm text-xs outline-none focus-visible:outline-2 focus-visible:outline-accent', tone === 'critical' ? 'text-critical' : 'text-caution')}>
        {children}
      </span>
    </Tooltip>
  )
}

/** Pointers that hover get tooltips; touch screens never show them, so they get the same text another way. */
function useFinePointer(): boolean {
  return useMediaQuery('(hover: hover) and (pointer: fine)')
}

/**
 * The reason a control is disabled, for a mouse: a disabled button takes no pointer events, so its
 * own tooltip never opens and the wrapper carries it. Keyboards and touch screens reach neither,
 * so every reason shown this way is also written out in the row's open panel.
 */
export function Reason({ reason, children }: { reason: string | null; children: ReactNode }) {
  return (
    <Tooltip label={reason ?? ''} disabled={!reason}>
      <span className="inline-flex">{children}</span>
    </Tooltip>
  )
}

/**
 * An explanation behind an info icon: a tooltip where pointers hover, a panel opened by a tap on
 * touch screens, where tooltips never show.
 */
export function InfoHint({ label, children, size = 14 }: { label: string; children: ReactNode; size?: number }) {
  const fine = useFinePointer()
  const [open, setOpen] = useState(false)
  const trigger = (
    <button type="button" aria-label={label} className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-ink-faint hover:text-ink focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:size-9">
      <Info size={size} />
    </button>
  )
  if (fine) return <Tooltip label={children}>{trigger}</Tooltip>
  return (
    <Popover open={open} onOpenChange={setOpen} label={label} trigger={trigger} side="bottom">
      <div className="max-w-[min(22rem,calc(100vw-2rem))] px-3 py-2 text-xs leading-relaxed text-ink">{children}</div>
    </Popover>
  )
}

function Chip({ children, tone }: { children: ReactNode; tone?: 'caution' }) {
  return (
    <span className={cx('inline-flex shrink-0 items-center rounded-sm px-1.5 text-[0.6875rem] leading-5', tone === 'caution' ? 'bg-caution/12 text-caution' : 'bg-surface-high text-ink-soft')}>
      {children}
    </span>
  )
}

/**
 * Collapses an open row on Escape, unless the key closed something of its own first: selects and
 * menus render in portals, outside the row's DOM, and get the key first.
 */
function useEscapeToCollapse(onCollapse: () => void) {
  const panel = useRef<HTMLDivElement>(null)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    if (!panel.current?.contains(event.target as Node)) return
    event.preventDefault()
    onCollapse()
  }
  return { panel, onKeyDown }
}

/**
 * One editable variant: a compact line (handle, number, CLI, name, model and list price, markers)
 * that opens into the full settings. The row calls `useAgentSettings` once for both views, so the
 * line reads the same catalog as the fields.
 */
export function VariantRow({
  shell,
  config,
  label,
  facts,
  unavailable,
  sameAs,
  defaults,
  probeModels,
  locked,
  removed,
  onConfigChange,
  onLabelChange,
  onDuplicate,
  duplicateLimit,
  onRemove,
  onRestore,
}: {
  shell: RowShell
  config: AgentConfig
  label: string | null
  facts: LineupFacts | undefined
  /** Why the CLI cannot run; null when it can. */
  unavailable: string | null
  /** Position of an identical earlier row, 1-based. */
  sameAs: number | null
  defaults: (agent: AgentKind) => AgentConfig | undefined
  probeModels: boolean
  locked?: LockedVariant
  /** Struck through until the dialog saves; only locked rows are kept this way. */
  removed?: boolean
  onConfigChange: (config: AgentConfig) => void
  onLabelChange: (label: string | null) => void
  onDuplicate: () => void
  /** Why no copy can be added (the lineup is full); null when one can. */
  duplicateLimit: string | null
  onRemove: () => void
  onRestore?: () => void
}) {
  const t = useTranslate()
  const fine = useFinePointer()
  const panelId = useId()
  const toggle = useRef<HTMLButtonElement>(null)
  const { groups, summary, catalogError } = useAgentSettings({ config, onConfigChange, probeModels })
  const collapse = () => {
    shell.onToggle()
    toggle.current?.focus()
  }
  const escape = useEscapeToCollapse(collapse)
  const chip = (key: string) => summary.find((segment) => segment.key === key)?.label ?? null
  const account = chip('account')
  const speed = config.agent === 'claude' && config.fastMode ? chip('speed') : null
  const ultracode = config.agent === 'claude' && config.ultracode ? chip('ultracode') : null
  const modelId = facts?.modelId ?? (config.model || null)
  const name = shell.title
  const keepOne = shell.count <= 1 ? t('benchmark.lineup.keepOne') : null
  const removeReason = locked?.removal === 'running' ? t('benchmark.lineup.removeRunning') : keepOne

  const toggleKeys = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Without a pointer to drag with, Alt and the arrows move the row from its own button.
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    shell.onMove(event.key === 'ArrowUp' ? -1 : 1)
  }

  return (
    <SortableShell rowKey={shell.rowKey} index={shell.index} sortable={shell.sortable && !removed} expanded={shell.expanded} removed={removed}>
      {(handle) => <>
        <div className="flex min-h-13 items-center gap-1.5 py-1 pr-1.5 pl-1 pointer-coarse:min-h-14">
          {handle}
          <span className="w-5 shrink-0 text-right text-xs text-ink-faint tabular-nums">{shell.index + 1}</span>
          <span className="flex w-6 shrink-0 justify-center"><AgentIcon agent={config.agent} size={16} /></span>
          <button
            ref={toggle}
            type="button"
            aria-expanded={shell.expanded}
            aria-controls={panelId}
            disabled={removed}
            onClick={shell.onToggle}
            onKeyDown={toggleKeys}
            aria-label={t(shell.expanded ? 'benchmark.lineup.collapse' : 'benchmark.lineup.expand', { name })}
            className="flex min-w-0 flex-1 flex-col items-start rounded-md px-1.5 py-1 text-left hover:bg-surface-high focus-visible:outline-2 focus-visible:outline-accent disabled:hover:bg-transparent"
          >
            <span className={cx('w-full truncate text-sm font-medium text-ink', removed && 'text-ink-faint line-through')} data-lineup-title>{name}</span>
            {/* Wraps rather than truncating: on a phone the exact model id would shrink to nothing. */}
            <span className="flex w-full min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-ink-faint">
              <span className="max-w-full truncate font-mono text-[0.6875rem]">{modelId ?? t('composer.select.default')}</span>
              {/* Each fact carries its own separator, so a wrapped line never ends on a dangling dot. */}
              {facts?.effort ? <span className="shrink-0 whitespace-nowrap">· {facts.effort}</span> : null}
              <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap"><span aria-hidden>·</span><PriceTag price={facts?.price ?? null} /></span>
              {account ? <Chip>{account}</Chip> : null}
              {speed ? <Chip>{speed}</Chip> : null}
              {ultracode ? <Chip>{ultracode}</Chip> : null}
              {locked?.cliVersion ? <span className="shrink-0 whitespace-nowrap">· v{locked.cliVersion}</span> : null}
            </span>
          </button>
          <span className="flex shrink-0 items-center gap-1.5">
            {locked && locked.runs.length > 0 ? <RunDots runs={locked.runs} /> : null}
            {unavailable ? <Marker tone="critical" label={unavailable}><OctagonAlert size={15} /></Marker> : null}
            {facts?.unlisted ? <Marker tone="caution" label={t('benchmark.lineup.unlisted')}><TriangleAlert size={15} /></Marker> : null}
            {sameAs !== null ? <Marker tone="caution" label={t('benchmark.lineup.sameAs', { n: sameAs })}><Equal size={15} /></Marker> : null}
            {facts?.mayAsk ? (
              // A word where there is room, an icon on a phone: an unattended run would stop and wait.
              <Tooltip label={t('benchmark.form.unattended')}>
                <span tabIndex={0} role="img" aria-label={t('benchmark.lineup.mayAsk')} className="inline-flex shrink-0 items-center gap-1 rounded-sm text-caution outline-none focus-visible:outline-2 focus-visible:outline-accent sm:bg-caution/12 sm:px-1.5" data-lineup-may-ask>
                  <Hourglass size={13} aria-hidden className="sm:hidden" />
                  <span aria-hidden className="hidden text-[0.6875rem] leading-5 sm:inline">{t('benchmark.lineup.mayAsk')}</span>
                </span>
              </Tooltip>
            ) : null}
          </span>
          {removed ? (
            <Button type="button" size="sm" variant="ghost" icon={<Undo2 size={14} />} onClick={onRestore}>{t('benchmark.lineup.undo')}</Button>
          ) : <>
            <span className="max-sm:hidden"><Reason reason={duplicateLimit}>
              <IconButton type="button" size="sm" label={t('benchmark.lineup.duplicate')} disabled={duplicateLimit !== null} onClick={onDuplicate}><Copy size={15} /></IconButton>
            </Reason></span>
            <span className="max-sm:hidden"><Reason reason={removeReason}>
              <IconButton type="button" size="sm" label={t('benchmark.form.removeVariant')} disabled={removeReason !== null} onClick={onRemove}><Trash2 size={15} /></IconButton>
            </Reason></span>
            <IconButton type="button" size="sm" label={t(shell.expanded ? 'benchmark.lineup.collapse' : 'benchmark.lineup.expand', { name })} onClick={shell.onToggle} tabIndex={-1} aria-hidden>
              <ChevronDown size={16} className={cx('transition-transform', shell.expanded && 'rotate-180')} />
            </IconButton>
          </>}
        </div>
        {shell.expanded && !removed ? (
          <div id={panelId} ref={escape.panel} onKeyDown={escape.onKeyDown} className="flex flex-col gap-3 border-t border-line/60 px-3 pt-3 pb-3 sm:pl-14" data-lineup-panel>
            {locked ? (
              <FrozenSettings agent={config.agent} segments={summary.map((segment) => segment.label)} technicalLabel={locked.technicalLabel} />
            ) : (
              <VariantFields config={config} groups={groups} catalogError={catalogError} onChange={onConfigChange} defaults={defaults} />
            )}
            <RowNotes
              notes={[
                unavailable ? { tone: 'critical' as const, text: unavailable } : null,
                facts?.unlisted ? { tone: 'caution' as const, text: t('benchmark.lineup.unlisted') } : null,
                sameAs !== null ? { tone: 'caution' as const, text: t('benchmark.lineup.sameAs', { n: sameAs }) } : null,
                facts?.mayAsk ? { tone: 'caution' as const, text: t('benchmark.form.unattended') } : null,
                locked?.removal === 'running' ? { tone: 'caution' as const, text: t('benchmark.lineup.removeRunning') } : null,
                locked && locked.runs.length > 0 && !fine ? { tone: 'muted' as const, text: runsText(t, locked.runs) } : null,
                !fine ? { tone: 'muted' as const, text: t(facts?.price ? 'benchmark.lineup.price.hint' : 'benchmark.lineup.price.none') } : null,
              ]}
            />
            <DisplayNameField label={label} placeholder={name} onChange={onLabelChange} />
            <RowFooter
              shell={shell}
              onDuplicate={onDuplicate}
              duplicateLimit={duplicateLimit}
              onRemove={onRemove}
              removeReason={removeReason}
              // A running variant's reason is already among the notes above.
              reasons={[duplicateLimit, locked?.removal === 'running' ? null : keepOne]}
              duplicateLabel={locked ? t('benchmark.lineup.duplicateNew') : t('benchmark.lineup.duplicateShort')}
            />
          </div>
        ) : null}
      </>}
    </SortableShell>
  )
}

/** A stored preset variant whose configuration no longer parses: shown, flagged, and only removable. */
export function BrokenVariantRow({ shell, agent, label, onRemove }: {
  shell: RowShell
  agent: AgentKind
  label: string | null
  onRemove: () => void
}) {
  const t = useTranslate()
  return (
    <SortableShell rowKey={shell.rowKey} index={shell.index} sortable={shell.sortable} expanded={false}>
      {(handle) => (
        <div className="flex min-h-13 items-center gap-1.5 py-1 pr-1.5 pl-1">
          {handle}
          <span className="w-5 shrink-0 text-right text-xs text-ink-faint tabular-nums">{shell.index + 1}</span>
          <span className="flex w-6 shrink-0 justify-center"><AgentIcon agent={agent} size={16} /></span>
          <div className="flex min-w-0 flex-1 flex-col px-1.5 py-1">
            <span className="truncate text-sm font-medium text-ink">{label ?? t('benchmark.lineup.invalidTitle', { cli: AGENT_LABELS[agent] })}</span>
            <span className="flex items-center gap-1.5 text-xs text-critical"><OctagonAlert size={13} className="shrink-0" /><span className="min-w-0">{t('benchmark.lineup.invalid')}</span></span>
          </div>
          <IconButton type="button" size="sm" label={t('benchmark.form.removeVariant')} onClick={onRemove}><Trash2 size={15} /></IconButton>
        </div>
      )}
    </SortableShell>
  )
}

function runsText(t: ReturnType<typeof useTranslate>, runs: BenchmarkRunDto[]): string {
  return [...runs].sort((a, b) => a.repetition - b.repetition)
    .map((run) => t('benchmark.lineup.runStatus', { run: t('benchmark.table.repetition', { n: run.repetition }), status: t(RUN_STATUS_LABELS[run.status]) }))
    .join(' · ')
}

/**
 * What the row's markers say, written out in its open panel: the markers are icons with tooltips,
 * and on a touch screen opening the row is the way to read them.
 */
function RowNotes({ notes }: { notes: ({ tone: 'critical' | 'caution' | 'muted'; text: string } | null)[] }) {
  const shown = notes.filter((note): note is { tone: 'critical' | 'caution' | 'muted'; text: string } => note !== null)
  if (shown.length === 0) return null
  return (
    <ul className="flex flex-col gap-1 text-xs leading-relaxed" data-lineup-notes>
      {shown.map((note) => (
        <li key={note.text} className={cx(note.tone === 'critical' ? 'text-critical' : note.tone === 'caution' ? 'text-caution' : 'text-ink-faint')}>{note.text}</li>
      ))}
    </ul>
  )
}

function RunDots({ runs }: { runs: BenchmarkRunDto[] }) {
  const t = useTranslate()
  const sorted = [...runs].sort((a, b) => a.repetition - b.repetition)
  const text = runsText(t, runs)
  return (
    <Tooltip label={text}>
      <span tabIndex={0} role="img" aria-label={text} className="inline-flex shrink-0 items-center gap-0.5 outline-none focus-visible:outline-2 focus-visible:outline-accent">
        {sorted.map((run) => <span key={run.id} aria-hidden className={cx('size-1.5 rounded-full', RUN_TONES[run.status])} />)}
      </span>
    </Tooltip>
  )
}

/** The settings a variant ran with, as text: they stay as they were so its runs remain comparable. */
function FrozenSettings({ agent, segments, technicalLabel }: { agent: AgentKind; segments: string[]; technicalLabel: string }) {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="text-ink-soft">{[AGENT_LABELS[agent], ...segments].join(' · ')}</p>
      <p className="font-mono text-xs text-ink-faint">{technicalLabel}</p>
      <p className="text-xs text-ink-faint">{t('benchmark.lineup.frozen')}</p>
    </div>
  )
}

function DisplayNameField({ label, placeholder, onChange }: { label: string | null; placeholder: string; onChange: (label: string | null) => void }) {
  const t = useTranslate()
  return (
    <div className="max-w-md">
      <Field
        label={t('benchmark.lineup.displayName')}
        hint={t('benchmark.lineup.displayNameHint')}
        value={label ?? ''}
        maxLength={80}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value.trim() ? event.target.value : null)}
      />
    </div>
  )
}

function RowFooter({ shell, onDuplicate, duplicateLimit, onRemove, removeReason, reasons, duplicateLabel }: {
  shell: RowShell
  onDuplicate: () => void
  duplicateLimit: string | null
  onRemove: () => void
  removeReason: string | null
  /** Why buttons below are disabled, written out. */
  reasons: (string | null)[]
  duplicateLabel: string
}) {
  const t = useTranslate()
  const written = [...new Set(reasons.filter((reason): reason is string => reason !== null))]
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" size="sm" variant="ghost" icon={<ArrowUp size={14} />} disabled={shell.index === 0} onClick={() => shell.onMove(-1)} data-lineup-move="up">{t('benchmark.lineup.moveUp')}</Button>
        <Button type="button" size="sm" variant="ghost" icon={<ArrowDown size={14} />} disabled={shell.index === shell.total - 1} onClick={() => shell.onMove(1)} data-lineup-move="down">{t('benchmark.lineup.moveDown')}</Button>
        <span className="flex-1" />
        <Reason reason={duplicateLimit}>
          <Button type="button" size="sm" variant="ghost" icon={<CopyPlus size={14} />} disabled={duplicateLimit !== null} onClick={onDuplicate}>{duplicateLabel}</Button>
        </Reason>
        <Reason reason={removeReason}>
          <Button type="button" size="sm" variant="danger" icon={<Trash2 size={14} />} disabled={removeReason !== null} onClick={onRemove}>{t('benchmark.lineup.removeShort')}</Button>
        </Reason>
      </div>
      {/* A disabled button takes neither focus nor touch, so its tooltip only reaches a mouse: the
          reasons are written out for keyboards and touch screens alike. */}
      {written.map((reason) => <p key={reason} className="text-xs text-ink-faint" data-lineup-reason>{reason}</p>)}
    </div>
  )
}

export type { RowShell }
