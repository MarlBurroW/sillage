import { Check, ChevronDown, CornerDownLeft, Folders, Globe, Inbox, ListFilter, MessageSquare, Plus, SquarePen, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ProjectDto } from '@sillage/protocol'
import { relativeDate } from '../../lib/dates'
import { useTranslate, type MessageKey } from '../../lib/i18n'
import {
  ATTENTION_GROUP,
  CREATE_GROUP,
  PALETTE_SHORTCUT,
  PROJECTS_GROUP,
  SESSION_GROUP,
  type PaletteHit,
  type PaletteItem,
} from '../../lib/palette'
import { splitExcerpt } from '../../lib/search'
import { Logo } from '../Logo'
import { ProjectAvatar } from '../ProjectAvatar'
import { Tooltip } from '../ui/Tooltip'
import { cx } from '../ui'

/** Presentation of the search palette: tokens before the input, group headings and rows. */

export function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <kbd className="rounded border border-line px-1 font-sans text-[0.625rem]">{keys}</kbd>
      {label}
    </span>
  )
}

/**
 * The project the palette searches, as one removable piece before the input rather than typed
 * text: it survives select-all, needs no quoting for names with spaces, and goes in one tap.
 */
export function ScopeToken({ project, onRemove }: { project: ProjectDto; onRemove: () => void }) {
  const t = useTranslate()
  return (
    <Tooltip label={t('search.scope.remove', { shortcut: PALETTE_SHORTCUT })} side="bottom">
      <button
        type="button"
        aria-label={t('search.scope.removeNamed', { name: project.name })}
        // Keep input focused: the next keystroke belongs to the query.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onRemove}
        className="group flex h-7 max-w-[45%] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-line bg-surface-high pr-1 pl-1.5 text-xs font-medium text-ink pointer-coarse:h-9"
      >
        <ProjectAvatar project={project} className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{project.name}</span>
        <X size={12} className="shrink-0 text-ink-faint group-hover:text-ink" />
      </button>
    </Tooltip>
  )
}

/** Once removed, the token leaves its place marked: touch screens have no shortcut to bring it back. */
export function ScopeOffer({ project, onAdd }: { project: ProjectDto; onAdd: () => void }) {
  const t = useTranslate()
  return (
    <Tooltip label={t('search.scope.add', { name: project.name })} side="bottom">
      <button
        type="button"
        aria-label={t('search.scope.add', { name: project.name })}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onAdd}
        className="flex h-7 max-w-[45%] shrink-0 cursor-pointer items-center gap-1 rounded-md border border-dashed border-line pr-1.5 pl-1 text-xs text-ink-faint hover:border-line-strong hover:text-ink-soft pointer-coarse:h-9"
      >
        <Plus size={12} className="shrink-0" />
        <span className="min-w-0 truncate">{project.name}</span>
      </button>
    </Tooltip>
  )
}

/** The question a step asks, in the token's place: its × is the way back to the search. */
export function StepToken({ title, onLeave }: { title: string; onLeave: () => void }) {
  const t = useTranslate()
  return (
    <Tooltip label={t('search.step.back')} side="bottom">
      <button
        type="button"
        aria-label={t('search.step.backNamed', { name: title })}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onLeave}
        className="group flex h-7 max-w-[45%] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-accent/40 bg-accent-wash pr-1 pl-2 text-xs font-medium text-ink pointer-coarse:h-9"
      >
        <span className="min-w-0 truncate">{title}</span>
        <X size={12} className="shrink-0 text-ink-faint group-hover:text-ink" />
      </button>
    </Tooltip>
  )
}

/** Groups that belong to no project, with the heading and mark that name them. */
const NAMED_GROUPS: Record<string, { label: MessageKey; icon: ReactNode }> = {
  [PROJECTS_GROUP]: { label: 'search.group.projects', icon: <Folders size={14} className="text-ink-faint" /> },
  [SESSION_GROUP]: { label: 'search.group.session', icon: <MessageSquare size={14} className="text-ink-faint" /> },
  [ATTENTION_GROUP]: { label: 'search.group.attention', icon: <Inbox size={14} className="text-caution" /> },
  [CREATE_GROUP]: { label: 'search.group.create', icon: <SquarePen size={14} className="text-ink-faint" /> },
}

/**
 * Sticky group heading identifies the project while scrolling its results. A project heading also
 * narrows the search to its project, keeping the query: the pointer's way to what Tab does.
 */
export function GroupHeader({ id, group, project, current, onScope }: {
  id: string
  /** Group key, naming the groups that belong to no project. */
  group: string
  project: ProjectDto | undefined
  current: boolean
  onScope: (() => void) | undefined
}) {
  const t = useTranslate()
  const named = NAMED_GROUPS[group]
  const label = (
    <>
      {project ? <ProjectAvatar project={project} className="size-4" /> : (named?.icon ?? <Logo size={14} className="text-accent" />)}
      <span className="min-w-0 truncate">{project ? project.name : t(named?.label ?? 'search.group.general')}</span>
      {current ? <span className="shrink-0 font-normal text-ink-faint">{t('search.group.current')}</span> : null}
    </>
  )
  return (
    <div id={id} className="surface sticky top-0 z-10 px-1 pt-1.5 text-xs font-semibold text-ink-soft">
      {project && onScope ? (
        <Tooltip label={t('search.group.narrow', { name: project.name })} side="right">
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onScope}
            className="group flex max-w-full cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-surface-high hover:text-ink"
          >
            {label}
            <ListFilter size={12} className="shrink-0 text-ink-faint opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100" />
          </button>
        </Tooltip>
      ) : (
        <div className="flex items-center gap-2 px-1.5 py-1">{label}</div>
      )}
    </div>
  )
}

/** Text with matching characters highlighted. */
function Highlighted({ text, positions }: { text: string; positions: readonly number[] }) {
  if (positions.length === 0) return <>{text}</>
  const marked = new Set(positions)
  const parts: { text: string; hit: boolean }[] = []
  for (let index = 0; index < text.length; index += 1) {
    const hit = marked.has(index)
    const last = parts.at(-1)
    if (last && last.hit === hit) last.text += text[index]
    else parts.push({ text: text[index] as string, hit })
  }
  return (
    <>
      {parts.map((part, index) =>
        part.hit ? (
          <mark key={index} className="bg-transparent font-semibold text-ink">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}

function Excerpt({ excerpt }: { excerpt: string }) {
  return (
    <>
      {splitExcerpt(excerpt).map((part, index) =>
        part.hit ? (
          // Use solid highlighting rather than accent wash, already present on selected rows and obscuring matches.
          <mark key={index} className="rounded bg-accent/25 px-0.5 font-medium text-ink">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}

function rowClass(selected: boolean, compact = false) {
  return cx(
    // Top scroll margin reserves sticky-heading space so keyboard selections do not slide underneath.
    'flex w-full cursor-pointer scroll-mt-9 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left',
    compact ? 'min-h-8 text-xs' : 'min-h-10 pointer-coarse:min-h-12',
    selected ? 'bg-accent-wash text-ink' : compact ? 'text-ink-faint' : 'text-ink-soft',
  )
}

export function HitRow({
  id,
  hit,
  selected,
  onHover,
  onSelect,
}: {
  id: string
  hit: PaletteHit
  selected: boolean
  onHover: () => void
  /** `aside` asks for the result beside the current view: a new tab or window. */
  onSelect: (aside: boolean) => void
}) {
  const { item } = hit
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      onMouseMove={onHover}
      // Keep input focused: clicking must not blur it before acting.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => onSelect(event.metaKey || event.ctrlKey)}
      className={rowClass(selected)}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-ink-faint">{item.icon}</span>

      <span className="min-w-0 flex-1">
        {/*
         * Preserve title space and truncate details: long instructions must not reduce task names
         * to three letters. On touch move details below instead of ellipsis.
         */}
        <span className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-2">
          <span className="max-w-full shrink-0 truncate text-sm">
            <Highlighted text={item.title} positions={hit.title} />
          </span>
          {item.detail ? (
            <span className="min-w-0 truncate text-xs text-ink-faint sm:flex-1">
              <Highlighted text={item.detail} positions={hit.detail} />
            </span>
          ) : null}
        </span>
        {item.excerpt ? (
          <span className="mt-0.5 line-clamp-2 text-xs text-ink-faint">
            <Excerpt excerpt={item.excerpt} />
          </span>
        ) : null}
      </span>

      {item.badge}
      <Aside item={item} />
    </div>
  )
}

/** Compute age only at display: of a thousand conversations, only ten are visible. */
function Aside({ item }: { item: PaletteItem }) {
  const parts = [item.aside, item.at === undefined ? undefined : relativeDate(item.at)].filter(Boolean)
  if (parts.length === 0) return null
  return <span className="shrink-0 text-[0.6875rem] text-ink-faint">{parts.join(' · ')}</span>
}

export function MoreRow({
  id,
  hidden,
  selected,
  onHover,
  onSelect,
}: {
  id: string
  hidden: number
  selected: boolean
  onHover: () => void
  onSelect: () => void
}) {
  const t = useTranslate()
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      onMouseMove={onHover}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      className={rowClass(selected, true)}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <ChevronDown size={14} />
      </span>
      <span>{t('search.more', { count: hidden })}</span>
    </div>
  )
}

export function WidenRow({
  id,
  count,
  separated,
  selected,
  onHover,
  onSelect,
}: {
  id: string
  count: number
  separated: boolean
  selected: boolean
  onHover: () => void
  onSelect: () => void
}) {
  const t = useTranslate()
  return (
    <div className={separated ? 'mt-1.5 border-t border-line pt-1.5' : 'pt-1.5'}>
      <div
        id={id}
        role="option"
        aria-selected={selected}
        onMouseMove={onHover}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onSelect}
        className={rowClass(selected)}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-ink-faint">
          <Globe size={15} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{t('search.widen')}</span>
        <span className="shrink-0 text-[0.6875rem] text-ink-faint">{t('search.widen.count', { count })}</span>
      </div>
    </div>
  )
}

/**
 * The only row of a step that takes typed text: it says what Enter will do with it, so the input
 * never looks like a search that found nothing.
 */
export function ActionRow({ id, label, disabled, selected, onSelect }: {
  id: string
  label: string
  disabled: boolean
  selected: boolean
  onSelect: () => void
}) {
  return (
    <div className="pt-1.5">
      <div
        id={id}
        role="option"
        aria-selected={selected}
        aria-disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={disabled ? undefined : onSelect}
        className={cx(rowClass(selected && !disabled), disabled && 'cursor-default opacity-60')}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-ink-faint">
          <CornerDownLeft size={15} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      </div>
    </div>
  )
}

/** Outcome of an action that left the palette open; an effect nobody can see needs saying. */
export function NoticeLine({ text, error }: { text: string; error?: boolean }) {
  return (
    <p role="status" className={cx('flex items-center gap-2 px-2.5 pt-3 pb-1 text-xs', error ? 'text-critical' : 'text-positive')}>
      {error ? null : <Check size={14} className="shrink-0" />}
      {text}
    </p>
  )
}
