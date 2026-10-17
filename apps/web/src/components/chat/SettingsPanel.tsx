import { TooltipButton } from '../ui/Tooltip'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Check, ChevronLeft, ChevronRight, GripVertical, Pin, PinOff, Plug, Search, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'
import { MODEL_EFFORT_KEYS, pinnedExtras, type SettingGroup } from './ComposerSettings'

interface SettingsPanelProps {
  groups: SettingGroup[]
  /** Catégories épinglées sous le composer, dans leur ordre ; sans `onPinnedChange`, ni épingle ni tri. */
  pinned?: string[]
  onPinnedChange?: (next: string[]) => void
  disabled?: boolean
  /** MCP est un choix multiple, rendu dans sa propre vue. */
  extra?: ReactNode
  feedback?: ReactNode
  onDone: () => void
  onClose: () => void
}

/** Clé de la vue MCP, qui n'est pas une catégorie à choix unique. */
const MCP_VIEW = '__mcp'

/**
 * Vue complète, en deux niveaux : une ligne par réglage avec sa valeur, et les options
 * d'un seul réglage à la fois.
 *
 * Tout déplié, le panneau faisait défiler une dizaine de listes pour en changer une ;
 * la liste tient sur un écran et dit déjà où l'on en est. Les réglages à deux états se
 * basculent depuis leur ligne, sans détour par une vue à deux options. Les choix
 * s'appliquent sans fermer le panneau.
 */
export function SettingsPanel({ groups, pinned = [], onPinnedChange, disabled, extra, feedback, onDone, onClose }: SettingsPanelProps) {
  const t = useTranslate()
  const [view, setView] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  // La ligne d'où l'on vient reprend le focus au retour : sans elle, le clavier
  // repartirait du haut du panneau à chaque réglage consulté.
  const returnTo = useRef<string | null>(null)
  const open = (key: string) => {
    returnTo.current = key
    setView(key)
  }
  const back = () => setView(null)
  useEffect(() => {
    if (view !== null || !returnTo.current) return
    list.current?.querySelector<HTMLElement>(`[data-setting-row="${returnTo.current}"]`)?.focus({ preventScroll: false })
  }, [view])

  const detail = view === null || view === MCP_VIEW ? null : groups.find((group) => group.key === view) ?? null
  // Une catégorie qui disparaît pendant qu'on la regarde (le modèle choisi n'a plus de
  // niveaux d'effort) ramène à la liste plutôt qu'à une vue vide.
  useEffect(() => {
    if (view !== null && view !== MCP_VIEW && !detail) setView(null)
  }, [view, detail])

  const present = new Set(groups.map((group) => group.key))
  // Modèle et effort sont toujours sous le composer, dans leur puce commune : ils ne
  // s'épinglent ni ne se déplacent.
  const fixed = MODEL_EFFORT_KEYS.flatMap((key) => groups.find((group) => group.key === key) ?? [])
  const pinnedGroups = onPinnedChange ? pinnedExtras(groups, pinned) : []
  const pinnedKeys = new Set([...MODEL_EFFORT_KEYS, ...pinnedGroups.map((group) => group.key)])
  const others = groups.filter((group) => !pinnedKeys.has(group.key))
  const togglePin = onPinnedChange
    ? (key: string) => {
        // Les clés modèle et effort d'une barre enregistrée avant la puce commune
        // partent à la première écriture : elles n'ont plus de sens ici.
        const extras = pinned.filter((item) => !MODEL_EFFORT_KEYS.includes(item))
        onPinnedChange(extras.includes(key) ? extras.filter((item) => item !== key) : [...extras, key])
      }
    : undefined
  // Le tri ne déplace que les catégories visibles, mais sur la liste entière : une clé
  // absente en ce moment (Ultracode sur un modèle qui ne le gère pas) garde sa place.
  const move = (from: string, to: string) => {
    if (!onPinnedChange || !present.has(from) || !present.has(to)) return
    onPinnedChange(arrayMove(pinned, pinned.indexOf(from), pinned.indexOf(to)))
  }

  const footer = (
    <>
      {feedback ? <div className="shrink-0 border-t border-line px-3 pt-2">{feedback}</div> : null}
      <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-line px-4 pt-3 pb-[max(0.75rem,var(--sg-safe-bottom))]">
        <p className="text-xs text-ink-faint">{t('composer.settings.immediate')}</p>
        <button type="button" onClick={onDone} className="min-h-11 shrink-0 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          {t('composer.settings.done')}
        </button>
      </footer>
    </>
  )

  if (detail) {
    return (
      <>
        <SettingsHeading title={detail.label} onClose={onClose} onBack={back}
          action={togglePin && !MODEL_EFFORT_KEYS.includes(detail.key) ? <PinButton group={detail} pinned={pinnedKeys.has(detail.key)} onToggle={togglePin} /> : null} />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
          {detail.notice ? <p className="mb-2 text-xs text-caution">{detail.notice}</p> : null}
          {/* Un choix ramène à la liste : c'est là qu'on voit qu'il a pris, et
              qu'on enchaîne sur le réglage suivant. */}
          <SettingOptions group={detail} disabled={disabled} compact={detail.key === 'effort' || detail.key === 'mode'}
            onPick={(value) => { detail.onChange(value); back() }} />
        </div>
        {footer}
      </>
    )
  }

  if (view === MCP_VIEW && extra) {
    return (
      <>
        <SettingsHeading title={t('cliDefaults.mcp.label')} onClose={onClose} onBack={back} />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">{extra}</div>
        {footer}
      </>
    )
  }

  return (
    <>
      <SettingsHeading title={t('composer.settings.title')} onClose={onClose} />
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
        {togglePin ? (
          <section aria-labelledby="settings-pinned" className="mb-2">
            <h3 id="settings-pinned" className="px-2 pt-1 pb-1.5 text-xs font-medium text-ink-faint">{t('composer.settings.pinnedSection')}</h3>
            <ul className="flex flex-col">
              {fixed.map((group) => (
                <li key={group.key} className="flex items-center">
                  <span aria-hidden className="w-8 shrink-0" />
                  <SettingRow group={group} disabled={disabled} onOpen={open} pinned={false} />
                  <span aria-hidden className="size-11 shrink-0" />
                </li>
              ))}
            </ul>
            {pinnedGroups.length > 0 ? (
              <PinnedList groups={pinnedGroups} disabled={disabled} onOpen={open} onTogglePin={togglePin} onMove={move} />
            ) : (
              <p className="px-2 pt-1 pb-2 text-xs text-ink-faint">{t('composer.settings.pinnedEmpty')}</p>
            )}
          </section>
        ) : (
          // Au téléphone, rien ne s'épingle : modèle et effort, qu'on vient changer
          // presque chaque fois, sont dépliés en tête plutôt que derrière une ligne.
          <InlineModelEffort groups={fixed} disabled={disabled} onOpen={open} />
        )}
        {others.length > 0 || extra ? (
          <section aria-labelledby="settings-others">
            <h3 id="settings-others" className="px-2 pt-1 pb-1.5 text-xs font-medium text-ink-faint">{t('composer.settings.otherSection')}</h3>
            <ul className="flex flex-col">
              {others.map((group) => (
                <li key={group.key} className="flex items-center">
                  {togglePin ? <span aria-hidden className="w-8 shrink-0" /> : null}
                  <SettingRow group={group} disabled={disabled} onOpen={open} onTogglePin={togglePin} pinned={false} />
                </li>
              ))}
              {extra ? (
                <li className="flex items-center">
                  {togglePin ? <span aria-hidden className="w-8 shrink-0" /> : null}
                  <button type="button" data-setting-row={MCP_VIEW} onClick={() => open(MCP_VIEW)} className={rowButtonClass}>
                    <span className="flex size-5 shrink-0 items-center justify-center text-accent"><Plug size={15} /></span>
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{t('cliDefaults.mcp.label')}</span>
                    <ChevronRight size={16} className="shrink-0 text-ink-faint" />
                  </button>
                  {/* Pas d'épingle : MCP est un choix multiple, qui n'a pas sa place dans
                      une puce. La colonne reste pour garder les chevrons alignés. */}
                  {togglePin ? <span aria-hidden className="size-11 shrink-0" /> : null}
                </li>
              ) : null}
            </ul>
          </section>
        ) : null}
      </div>
      {footer}
    </>
  )
}

/** Au-delà, la liste des modèles reste derrière sa ligne : elle repousserait tout le reste. */
const INLINE_MODELS_MAX = 6

function InlineModelEffort({ groups, disabled, onOpen }: { groups: SettingGroup[]; disabled?: boolean; onOpen: (key: string) => void }) {
  return (
    <div className="mb-2">
      {groups.map((group) => group.key === 'model' && group.options.length > INLINE_MODELS_MAX ? (
        <SettingRow key={group.key} group={group} disabled={disabled} onOpen={onOpen} pinned={false} />
      ) : (
        <section key={group.key} aria-label={group.label} className="px-2 pb-3">
          <h3 className="pt-1 pb-1.5 text-xs font-medium text-ink-faint">{group.label}</h3>
          {group.notice ? <p className="mb-2 text-xs text-caution">{group.notice}</p> : null}
          <SettingOptions group={group} disabled={disabled} compact={group.key === 'effort'} onPick={group.onChange} />
        </section>
      ))}
    </div>
  )
}

const rowButtonClass = cx(
  'flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-md px-2 text-left',
  'hover:bg-surface-high focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
  'disabled:pointer-events-none disabled:opacity-45',
)

/** Les réglages épinglés, dans l'ordre de la barre, triables à la poignée ou au clavier. */
function PinnedList({ groups, disabled, onOpen, onTogglePin, onMove }: {
  groups: SettingGroup[]
  disabled?: boolean
  onOpen: (key: string) => void
  onTogglePin: (key: string) => void
  onMove: (from: string, to: string) => void
}) {
  const t = useTranslate()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const label = (key: unknown) => groups.find((group) => group.key === key)?.label ?? String(key)
  const position = (key: unknown) => groups.findIndex((group) => group.key === key) + 1
  const onDragEnd = (event: DragEndEvent) => {
    if (event.over && event.active.id !== event.over.id) onMove(String(event.active.id), String(event.over.id))
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis, restrictToParentElement]} onDragEnd={onDragEnd}
      accessibility={{
        screenReaderInstructions: { draggable: t('composer.settings.reorder.instructions') },
        announcements: {
          onDragStart: ({ active }) => t('composer.settings.reorder.picked', { setting: label(active.id) }),
          onDragOver: ({ active, over }) => over ? t('composer.settings.reorder.moved', { setting: label(active.id), position: String(position(over.id)) }) : undefined,
          onDragEnd: ({ active, over }) => over ? t('composer.settings.reorder.dropped', { setting: label(active.id), position: String(position(over.id)) }) : undefined,
          onDragCancel: ({ active }) => t('composer.settings.reorder.cancelled', { setting: label(active.id) }),
        },
      }}
    >
      <SortableContext items={groups.map((group) => group.key)} strategy={verticalListSortingStrategy}>
        <ul className="flex flex-col">
          {groups.map((group) => (
            <SortableRow key={group.key} group={group} disabled={disabled} onOpen={onOpen} onTogglePin={onTogglePin} sortable={groups.length > 1} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  )
}

function SortableRow({ group, disabled, onOpen, onTogglePin, sortable }: {
  group: SettingGroup
  disabled?: boolean
  onOpen: (key: string) => void
  onTogglePin: (key: string) => void
  sortable: boolean
}) {
  const t = useTranslate()
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: group.key, disabled: !sortable })
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx('relative flex items-center', isDragging && 'z-10 rounded-md bg-surface shadow-pop')}
    >
      {sortable ? (
        // La poignée seule déclenche le glissement : la ligne reste un bouton qu'on
        // touche pour ouvrir le réglage, et le défilement au doigt reste possible.
        <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners}
          aria-label={t('composer.settings.reorder', { setting: group.label })}
          className="flex h-11 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-ink-faint hover:bg-surface-high hover:text-ink focus-visible:outline-2 focus-visible:outline-accent active:cursor-grabbing"
        >
          <GripVertical size={16} />
        </button>
      ) : <span aria-hidden className="w-8 shrink-0" />}
      <SettingRow group={group} disabled={disabled} onOpen={onOpen} onTogglePin={onTogglePin} pinned />
    </li>
  )
}

/** Une ligne : la catégorie, sa valeur, et de quoi la changer. */
function SettingRow({ group, disabled, onOpen, onTogglePin, pinned }: {
  group: SettingGroup
  disabled?: boolean
  onOpen: (key: string) => void
  onTogglePin?: (key: string) => void
  pinned: boolean
}) {
  const t = useTranslate()
  const current = group.options.find((option) => option.value === group.value)
  const value = current?.label || group.value || t('composer.select.default')
  const caution = current?.tone === 'caution'
  const binary = group.active !== undefined
  const other = binary ? group.options.find((option) => option.value !== group.value && !option.disabled) : undefined
  const body = (
    <>
      <span className={cx('flex size-5 shrink-0 items-center justify-center', caution ? 'text-caution' : 'text-accent')}>{group.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink">{group.label}</span>
        <span className={cx('block truncate text-xs', caution ? 'text-caution' : 'text-ink-faint')}>{value}</span>
        {group.notice ? <span className="block truncate text-xs text-caution">{group.notice}</span> : null}
      </span>
    </>
  )
  return (
    <div className="flex min-w-0 flex-1 items-center">
      {binary ? (
        // Deux états : la ligne entière est l'interrupteur, sans vue intermédiaire.
        <button type="button" role="switch" aria-checked={group.value === group.active} data-setting-row={group.key}
          aria-label={t('composer.settings.quick', { setting: group.label, value })}
          disabled={disabled || !other} onClick={() => { if (other) group.onChange(other.value) }} className={rowButtonClass}
        >
          {body}
          <span aria-hidden className={cx('flex h-5 w-8 shrink-0 items-center rounded-full p-0.5 transition-colors',
            group.value === group.active ? cx('justify-end', caution ? 'bg-caution' : 'bg-accent') : 'bg-line-strong')}>
            <span className="size-4 rounded-full bg-surface shadow-sm" />
          </span>
        </button>
      ) : (
        <button type="button" data-setting-row={group.key} disabled={disabled}
          aria-label={t('composer.settings.quick', { setting: group.label, value })}
          onClick={() => onOpen(group.key)} className={rowButtonClass}
        >
          {body}
          <ChevronRight size={16} className="shrink-0 text-ink-faint" />
        </button>
      )}
      {onTogglePin ? <PinButton group={group} pinned={pinned} onToggle={onTogglePin} /> : null}
    </div>
  )
}

function PinButton({ group, pinned, onToggle }: { group: SettingGroup; pinned: boolean; onToggle: (key: string) => void }) {
  const t = useTranslate()
  const label = t(pinned ? 'composer.settings.unpin' : 'composer.settings.pin', { setting: group.label })
  return (
    <TooltipButton type="button" aria-pressed={pinned} aria-label={label} title={label} onClick={() => onToggle(group.key)}
      className={cx('flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-surface-high hover:text-ink focus-visible:outline-2 focus-visible:outline-accent',
        pinned ? 'text-accent' : 'text-ink-faint')}
    >
      {pinned ? <PinOff size={15} /> : <Pin size={15} />}
    </TooltipButton>
  )
}

export function SettingsHeading({ title, onClose, onBack, action }: { title: string; onClose: () => void; onBack?: () => void; action?: ReactNode }) {
  const t = useTranslate()
  const heading = useRef<HTMLHeadingElement>(null)
  // Entrer dans une vue détail y porte le focus : le bouton qui l'a ouverte vient de
  // disparaître, et le lecteur d'écran doit savoir où il est arrivé.
  useEffect(() => {
    if (onBack) heading.current?.focus({ preventScroll: true })
  }, [onBack, title])
  return (
    <header className={cx('flex shrink-0 items-center gap-1 border-b border-line py-2 pr-2', onBack ? 'pl-1' : 'pl-4')}>
      {onBack ? (
        <TooltipButton type="button" onClick={onBack} aria-label={t('composer.settings.back')} className="flex size-11 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-surface-high hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
          <ChevronLeft size={18} />
        </TooltipButton>
      ) : null}
      <h2 ref={heading} tabIndex={-1} data-settings-heading className="min-w-0 flex-1 truncate text-sm font-semibold outline-none">{title}</h2>
      {action}
      <TooltipButton type="button" onClick={onClose} aria-label={t('common.close')} className="flex size-11 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-surface-high hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
        <X size={18} />
      </TooltipButton>
    </header>
  )
}

/** Flèches pour parcourir ; Entrée/Espace pour choisir, sans fermeture accidentelle. */
export function SettingOptions({ group, onPick, disabled = false, compact = false, dense = false }: {
  group: SettingGroup
  onPick: (value: string) => void
  disabled?: boolean
  compact?: boolean
  /** Lignes serrées, description sur une ligne : pour une longue liste à parcourir d'un coup d'œil. */
  dense?: boolean
}) {
  const t = useTranslate()
  const id = useId()
  const [query, setQuery] = useState('')
  const searchable = group.key === 'model' && group.options.length > 8
  const normalized = query.trim().toLocaleLowerCase()
  const options = searchable && normalized
    ? group.options.filter((option) => `${option.label} ${option.hint ?? ''}`.toLocaleLowerCase().includes(normalized))
    : group.options
  const items = useRef<(HTMLButtonElement | null)[]>([])
  const selectable = options.flatMap((option, index) => option.disabled || disabled ? [] : [index])
  const checkedIndex = options.findIndex((option) => option.value === group.value)
  const tabIndex = selectable.includes(checkedIndex) ? checkedIndex : selectable[0]
  const selected = group.options.find((option) => option.value === group.value)

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (selectable.length === 0) return
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0
    if (step !== 0) {
      event.preventDefault()
      const next = selectable[(selectable.indexOf(index) + step + selectable.length) % selectable.length]
      if (next !== undefined) items.current[next]?.focus()
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const edge = event.key === 'Home' ? selectable[0] : selectable[selectable.length - 1]
      if (edge !== undefined) items.current[edge]?.focus()
    }
  }

  return (
    <>
      {searchable ? (
        <label className="mb-2 flex min-h-11 items-center gap-2 rounded-md border border-line px-3 text-ink-faint">
          <Search size={16} className="shrink-0" />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t('composer.settings.searchModels')} placeholder={t('composer.settings.searchModels')} className="min-w-0 flex-1 bg-transparent py-2 text-base text-ink outline-none focus-visible:outline-2 focus-visible:outline-accent" />
        </label>
      ) : null}
      <div role="radiogroup" aria-label={group.label} className={cx(compact ? 'grid gap-1.5' : 'flex flex-col gap-1', compact && (options.length <= 2 ? 'grid-cols-2' : 'grid-cols-3'))}>
        {options.map((option, index) => {
          const checked = option.value === group.value
          return (
            <button key={option.value} type="button" role="radio" aria-checked={checked}
              aria-describedby={compact && checked && option.hint ? `${id}-hint` : undefined}
              disabled={disabled || option.disabled}
              ref={(node) => { items.current[index] = node }}
              tabIndex={index === tabIndex ? 0 : -1}
              onKeyDown={(event) => onKeyDown(event, index)}
              onClick={() => onPick(option.value)}
              className={cx(
                'flex min-h-11 min-w-0 items-center gap-2 rounded-md border text-left transition-colors',
                'hover:bg-accent-wash focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                'disabled:pointer-events-none disabled:opacity-45',
                compact ? 'justify-center px-1.5 py-2 text-center text-xs' : dense ? 'px-3 py-1 text-sm md:min-h-9 pointer-coarse:min-h-11' : 'px-3 py-2 text-sm',
                checked ? 'border-accent/40 bg-accent-wash' : compact ? 'border-line' : 'border-transparent',
                option.tone === 'caution' ? 'text-caution' : checked ? 'text-ink' : 'text-ink-soft',
              )}
            >
              <span className={cx('min-w-0 flex-1', !dense && 'wrap-anywhere')}>
                <span className={cx('flex items-center gap-1.5 font-medium', compact && 'justify-center')}>
                  {option.icon ? <span className="shrink-0">{option.icon}</span> : null}{option.label}
                </span>
                {!compact && option.hint ? <span className={cx('block text-xs text-ink-faint', dense ? 'truncate' : 'mt-0.5')} title={dense ? option.hint : undefined}>{option.hint}</span> : null}
              </span>
              {!compact ? <Check size={16} aria-hidden className={cx('shrink-0 text-accent', !checked && 'invisible')} /> : null}
            </button>
          )
        })}
      </div>
      {options.length === 0 ? <p className="px-3 py-4 text-sm text-ink-faint">{t('composer.settings.empty')}</p> : null}
      {compact && selected?.hint ? <p id={`${id}-hint`} className="mt-2 text-xs text-ink-faint">{selected.hint}</p> : null}
    </>
  )
}
