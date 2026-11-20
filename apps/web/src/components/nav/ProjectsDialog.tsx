import * as Dialog from '@radix-ui/react-dialog'
import type { ProjectDto } from '@sillage/protocol'
import { GitBranch, Plus, Search, SlidersHorizontal, Users, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { activityTone, type ActivityCounts } from '../../lib/activity'
import { useTranslate } from '../../lib/i18n'
import type { RailProjects } from '../../lib/rail-projects'
import { scoreMatch } from '../../lib/search'
import { useMediaQuery } from '../../lib/viewport'
import { ProjectMark } from '../ProjectMark'
import { Button, IconButton, Segmented, cx } from '../ui'
import { RailToggle } from './RailToggle'
import { countsLabel } from './shared'

type Filter = 'all' | 'kept' | 'others'

interface ProjectsProps {
  projects: ProjectDto[]
  rail: RailProjects
  currentId: string | undefined
  /** Project ids, most recently visited first. */
  recent: string[]
  countsOf: (projectId: string) => ActivityCounts
  onOpenProject: (project: ProjectDto) => void
  onCreate: () => void
  onSettings: (project: ProjectDto) => void
}

/**
 * Every project at a glance: where each lives, what it holds and what waits there, with the same
 * rail button as the rail's own panel. That panel is the quick way; this is the full list, and the
 * place a new project starts from.
 */
export function ProjectsDialog({ open, onOpenChange, ...projects }: ProjectsProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const leave = (action: () => void) => { onOpenChange(false); action() }
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content aria-describedby={undefined} data-projects-dialog className="fixed top-[8dvh] left-1/2 z-50 flex max-h-[84dvh] w-[calc(100%-1.5rem)] max-w-2xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-float">
          <Projects {...projects} onOpenProject={(project) => leave(() => projects.onOpenProject(project))} onCreate={() => leave(projects.onCreate)} onSettings={(project) => leave(() => projects.onSettings(project))} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Mounted with the dialog, so each opening starts from an empty search and the rail as it stands. */
function Projects({ projects, rail, currentId, recent, countsOf, onOpenProject, onCreate, onSettings }: ProjectsProps) {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  // Rows keep the order they opened in: adding one to the rail must not move it from under the pointer.
  const [keptOnOpen] = useState<ReadonlySet<string>>(() => new Set(rail.kept.map((project) => project.id)))
  const list = useRef<HTMLUListElement>(null)
  const touch = useMediaQuery('(pointer: coarse)')

  const needle = query.trim()
  const visited = (project: ProjectDto) => { const index = recent.indexOf(project.id); return index === -1 ? recent.length : index }
  // The rail's projects in its order, then the others, latest visited first.
  const ordered = [...projects.filter((project) => keptOnOpen.has(project.id)), ...projects.filter((project) => !keptOnOpen.has(project.id)).sort((a, b) => visited(a) - visited(b))]
  const shown = ordered.filter((project) => (filter === 'all' || (filter === 'kept') === rail.isKept(project.id)) && (!needle || scoreMatch(project.name, needle) !== null))

  return (
    <>
      <div className="flex shrink-0 items-start gap-2 px-5 pt-4 pb-3 max-sm:px-4">
        <div className="min-w-0 flex-1">
          <Dialog.Title className="flex items-baseline gap-2 text-base font-semibold">{t('shell.projects.heading')}<span className="text-xs font-normal text-ink-faint tabular-nums">{projects.length}</span></Dialog.Title>
          <p className="mt-0.5 text-xs text-ink-faint max-sm:hidden">{t('shell.projects.hint')}</p>
        </div>
        <Button size="sm" icon={<Plus size={15} />} onClick={onCreate}>{t('projects.create.title')}</Button>
        <Dialog.Close asChild><IconButton label={t('common.close')}><X size={16} /></IconButton></Dialog.Close>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pb-3 max-sm:px-4">
        <div className="flex min-w-48 flex-1 items-center gap-2 rounded-md border border-line bg-sunken px-3 focus-within:border-accent">
          <Search size={15} className="shrink-0 text-ink-faint" />
          <input autoFocus={!touch} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('shell.switcher.search')} aria-label={t('shell.switcher.search')}
            className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none pointer-coarse:h-11 pointer-coarse:text-base"
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              const first = list.current?.querySelector<HTMLButtonElement>('[data-project-choice]')
              if (event.key === 'ArrowDown') { event.preventDefault(); first?.focus() }
              if (event.key === 'Enter') { event.preventDefault(); first?.click() }
            }} />
        </div>
        <Segmented label={t('shell.projects.filter')} value={filter} onChange={setFilter} options={[
          { value: 'all', label: t('shell.projects.filter.all'), text: t('shell.projects.filter.all') },
          { value: 'kept', label: t('shell.rail.picker.kept'), text: t('shell.rail.picker.kept') },
          { value: 'others', label: t('shell.projects.filter.others'), text: t('shell.projects.filter.others') },
        ]} />
      </div>
      <ul ref={list} className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-line p-2" onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        const choices = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[data-project-choice]') ?? [])
        const index = choices.indexOf((event.target as HTMLElement).closest('li')?.querySelector('[data-project-choice]') as HTMLButtonElement)
        if (index < 0) return
        event.preventDefault()
        choices[(index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length]?.focus()
      }}>
        {shown.map((project) => {
          const counts = countsOf(project.id)
          const tone = activityTone(counts)
          const sessions = t(project.conversationCount === 1 ? 'shell.projects.sessions.one' : 'shell.projects.sessions', { count: project.conversationCount })
          return (
            <li key={project.id} className="flex items-center gap-1 rounded-lg pr-1.5 transition-colors focus-within:bg-surface-high hover:bg-surface-high">
              <button type="button" data-project-choice aria-current={project.id === currentId ? true : undefined} onClick={() => onOpenProject(project)}
                className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent">
                <ProjectMark project={project} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <span className="truncate">{project.name}</span>
                    {/* Mark only shared projects: private is normal and a lock on every project adds no information. */}
                    {project.visibility === 'shared' ? <Users size={12} className="shrink-0 text-ink-faint" aria-label={t('shell.project.shared')} /> : null}
                    {project.id === currentId ? <span className="shrink-0 rounded bg-accent-wash px-1.5 text-[0.625rem] leading-4 font-medium text-accent">{t('shell.projects.current')}</span> : null}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-faint">
                    <span className="truncate font-mono text-[0.6875rem]" title={project.workspacePath}>{project.workspacePath}</span>
                    {project.git ? <span className="flex shrink-0 items-center gap-1 max-sm:hidden"><GitBranch size={11} /><span className="max-w-32 truncate">{project.git.branch}</span></span> : null}
                    <span className="shrink-0 tabular-nums max-sm:hidden">· {sessions}</span>
                  </span>
                </span>
                {tone ? <span className="flex shrink-0 items-center gap-1.5 text-xs text-ink-soft"><span aria-hidden className={cx('nav-inline-dot', `nav-tone-${tone}`)} /><span className="max-sm:sr-only">{countsLabel(counts, t)}</span></span> : null}
              </button>
              <RailToggle project={project} rail={rail} />
              <IconButton size="sm" label={t('shell.project.settings')} onClick={() => onSettings(project)}><SlidersHorizontal size={15} /></IconButton>
            </li>
          )
        })}
        {shown.length === 0 && <li role="status" className="px-2 py-10 text-center text-sm text-ink-faint">
          {t(projects.length === 0 ? 'shell.projects.empty' : !needle && filter === 'others' ? 'shell.projects.allKept' : 'shell.switcher.empty')}
        </li>}
      </ul>
    </>
  )
}
