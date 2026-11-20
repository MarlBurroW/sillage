import type { ProjectDto } from '@sillage/protocol'
import { LayoutGrid, Plus, Search } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { activityTone, type ActivityCounts } from '../../lib/activity'
import { useTranslate } from '../../lib/i18n'
import type { RailProjects } from '../../lib/rail-projects'
import { scoreMatch } from '../../lib/search'
import { useMediaQuery } from '../../lib/viewport'
import { ProjectMark } from '../ProjectMark'
import { Button, Popover, cx } from '../ui'
import { RailToggle } from './RailToggle'

interface PickerProps {
  projects: ProjectDto[]
  rail: RailProjects
  /** Project ids, most recently visited first. */
  recent: string[]
  countsOf: (projectId: string) => ActivityCounts
  onOpenProject: (project: ProjectDto) => void
  onCreate: () => void
  onManage: () => void
}

/**
 * What the rail's last entry opens: every project beside the rail it fills. A row opens its
 * project; its button adds it to the rail or takes it off, and the mark appears or leaves right
 * next to the panel, which is why this is not a dialog over the rail.
 */
export function AddToRailPopover({ trigger, zone, ...picker }: PickerProps & {
  trigger: ReactElement
  /** The rail's projects zone around the wired entry: steadier than the entry, which each added project pushes down. */
  zone: (entry: ReactElement) => ReactElement
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const touch = useMediaQuery('(pointer: coarse)')
  // Leaving for a page or the full list: focus sent back to the entry would raise its tooltip over them.
  const leaving = useRef(false)
  const leave = (action: () => void) => { leaving.current = true; setOpen(false); action() }

  return (
    <Popover open={open} onOpenChange={setOpen} trigger={trigger} frame={zone} side="right" align="start" label={t('shell.rail.picker.title')}
      // A field focused on touch raises the keyboard over the list before anything was asked.
      onOpenAutoFocus={touch ? (event) => event.preventDefault() : undefined}
      onCloseAutoFocus={(event) => { if (leaving.current) event.preventDefault(); leaving.current = false }}
      className="w-[min(21.5rem,calc(100vw-4.75rem))]">
      <Picker {...picker} onOpenProject={(project) => leave(() => picker.onOpenProject(project))} onCreate={() => leave(picker.onCreate)} onManage={() => leave(picker.onManage)} />
    </Popover>
  )
}

/** Mounted with the panel, so each opening starts from an empty search and the rail as it stands. */
function Picker({ projects, rail, recent, countsOf, onOpenProject, onCreate, onManage }: PickerProps) {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  // Rows keep the group they opened in: one that changed group on click would slide from under the pointer.
  const [keptOnOpen] = useState<ReadonlySet<string>>(() => new Set(rail.kept.map((project) => project.id)))
  const list = useRef<HTMLDivElement>(null)
  // Keep the opening height: near the bottom of the screen the panel is pushed up by its own size, and
  // a list shrinking with the search would move the field being typed in.
  const [height, setHeight] = useState<number>()
  useLayoutEffect(() => { if (list.current) setHeight(list.current.offsetHeight) }, [])

  const needle = query.trim()
  const matches = projects.filter((project) => !needle || scoreMatch(project.name, needle) !== null)
  // The ones to add come first, since that is what the entry is for: the open one, those that need
  // a look, then the latest visited.
  const rank = (project: ProjectDto) => {
    const visited = recent.indexOf(project.id)
    return (project.id === rail.visiting?.id ? 0 : activityTone({ ...countsOf(project.id), running: 0 }) ? 1 : 2) * 1000 + (visited === -1 ? 999 : visited)
  }
  const groups = [
    { key: 'others', label: t('shell.rail.picker.others'), entries: matches.filter((project) => !keptOnOpen.has(project.id)).sort((a, b) => rank(a) - rank(b)) },
    { key: 'kept', label: t('shell.rail.picker.kept'), entries: matches.filter((project) => keptOnOpen.has(project.id)) },
  ]

  return (
    <>
      <div className="shrink-0 px-3.5 pt-3">
        <h2 className="text-sm font-semibold">{t('shell.rail.picker.title')}</h2>
        <p className="mt-0.5 text-xs text-ink-faint">{t('shell.rail.picker.hint')}</p>
      </div>
      {projects.length > 0 && <div className="mx-3 mt-2.5 mb-1 flex shrink-0 items-center gap-2 rounded-md border border-line bg-sunken px-2.5 focus-within:border-accent">
        <Search size={14} className="shrink-0 text-ink-faint" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('shell.switcher.search')} aria-label={t('shell.switcher.search')}
          className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none pointer-coarse:text-base"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            const first = list.current?.querySelector<HTMLButtonElement>('[data-project-choice]')
            if (event.key === 'ArrowDown') { event.preventDefault(); first?.focus() }
            if (event.key === 'Enter') { event.preventDefault(); first?.click() }
          }} />
      </div>}
      <div ref={list} style={{ height }} className="max-h-[21rem] min-h-0 overflow-y-auto overscroll-contain px-1.5 pb-1.5" onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        const choices = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[data-project-choice]') ?? [])
        const index = choices.indexOf((event.target as HTMLElement).closest('[data-project-row]')?.querySelector('[data-project-choice]') as HTMLButtonElement)
        if (index < 0) return
        event.preventDefault()
        choices[(index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length]?.focus()
      }}>
        {groups.map((group) => group.entries.length > 0 && <section key={group.key} aria-label={group.label}>
          <h3 className="px-2 pt-2.5 pb-1 text-[0.6875rem] font-semibold text-ink-faint">{group.label}</h3>
          {group.entries.map((project) => {
            const tone = activityTone(countsOf(project.id))
            return (
              <div key={project.id} data-project-row className="flex items-center gap-1 rounded-md pr-1.5 transition-colors focus-within:bg-surface-high hover:bg-surface-high">
                <button type="button" data-project-choice onClick={() => onOpenProject(project)}
                  className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent pointer-coarse:min-h-11">
                  <ProjectMark project={project} size={26} />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {tone ? <span aria-hidden className={cx('nav-inline-dot', `nav-tone-${tone}`)} /> : null}
                </button>
                <RailToggle project={project} rail={rail} />
              </div>
            )
          })}
        </section>)}
        {matches.length === 0 && <p role="status" className="px-2 py-6 text-center text-sm text-ink-faint">{t(projects.length === 0 ? 'shell.projects.empty' : 'shell.switcher.empty')}</p>}
      </div>
      <div className="flex shrink-0 gap-2 border-t border-line p-2.5">
        <Button size="sm" className="min-w-0 flex-1 max-sm:px-2" icon={<Plus size={15} className="shrink-0" />} onClick={onCreate}>{t('projects.create.title')}</Button>
        <Button size="sm" variant="secondary" className="min-w-0 flex-1 max-sm:px-2" icon={<LayoutGrid size={14} className="shrink-0" />} onClick={onManage}>{t('shell.switcher.manage')}</Button>
      </div>
    </>
  )
}
