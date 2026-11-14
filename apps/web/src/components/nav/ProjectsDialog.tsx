import * as Dialog from '@radix-ui/react-dialog'
import type { ProjectDto } from '@sillage/protocol'
import { Check, FolderPlus, Pin, Search, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { activityTone, type ActivityCounts } from '../../lib/activity'
import { useTranslate } from '../../lib/i18n'
import { useTogglePin } from '../../lib/projects'
import { scoreMatch } from '../../lib/search'
import { ProjectAvatar } from '../ProjectAvatar'
import { TooltipButton } from '../ui/Tooltip'
import { cx, IconButton } from '../ui'

/**
 * Every project, searchable: the rail holds only the pinned ones, this is where the others are
 * reached and where pins are chosen.
 */
export function ProjectsDialog({ trigger, projects, selected, onSelect, recent, userId, countsOf, onNavigate }: {
  trigger: ReactElement
  projects: ProjectDto[]
  selected?: ProjectDto
  onSelect: (project: ProjectDto) => void
  recent: string[]
  userId: string
  countsOf: (projectId: string) => ActivityCounts
  onNavigate: () => void
}) {
  const t = useTranslate()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const togglePin = useTogglePin()
  // Migrate old browser-local pins to the server once, then remove the local key to prevent replay.
  useEffect(() => {
    if (!userId || projects.length === 0) return
    const storageKey = `sillage.pinnedProjects:${userId}`
    try {
      const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
      if (value === null) return
      localStorage.removeItem(storageKey)
      if (!Array.isArray(value)) return
      for (const id of value) {
        const project = projects.find((entry) => entry.id === id)
        if (project && !project.pinned) togglePin.mutate({ id: project.id, pinned: true })
      }
    } catch { /* Optional storage. */ }
    // Run once per account: list-change reruns would repin projects.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, projects.length > 0])
  const matches = projects.filter((project) => scoreMatch(project.name, query.trim()) !== null || !query.trim())
  const groups = [
    { label: t('shell.switcher.pinned'), entries: matches.filter((project) => project.pinned) },
    { label: t('shell.switcher.recent'), entries: recent.slice(0, 5).flatMap((id) => matches.filter((project) => project.id === id && !project.pinned)) },
    { label: t('shell.projects.heading'), entries: matches.filter((project) => !project.pinned && !recent.slice(0, 5).includes(project.id)) },
  ]
  return (
    <Dialog.Root open={open} onOpenChange={(value) => { setOpen(value); if (!value) setQuery('') }}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content aria-describedby={undefined} className="fixed top-[10dvh] left-1/2 z-50 flex max-h-[80dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-float">
          <div className="flex items-center justify-between px-4 pt-3"><Dialog.Title className="text-sm font-semibold">{t('shell.switcher.all')}</Dialog.Title><Dialog.Close asChild><IconButton label={t('common.close')}><X size={16} /></IconButton></Dialog.Close></div>
          <div className="m-3 flex items-center gap-2 rounded-md border border-line bg-sunken px-3"><Search size={16} className="text-ink-faint" /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              const first = list.current?.querySelector<HTMLButtonElement>('[data-project-choice]')
              if (event.key === 'ArrowDown') { event.preventDefault(); first?.focus() }
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); first?.click() }
            }} placeholder={t('shell.switcher.search')} aria-label={t('shell.switcher.search')} className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none" /></div>
          <div ref={list} className="min-h-0 overflow-y-auto px-2 pb-2" onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            const choices = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[data-project-choice]') ?? [])
            const index = choices.indexOf(event.target as HTMLButtonElement)
            if (index < 0) return
            event.preventDefault()
            choices[(index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length]?.focus()
          }}>
            {groups.map((group) => group.entries.length > 0 && <div key={group.label}>
              <p className="px-2 pt-3 pb-1 text-[0.6875rem] font-semibold text-ink-faint">{group.label}</p>
              {group.entries.map((project) => {
                const tone = activityTone(countsOf(project.id))
                const current = selected?.id === project.id
                const pinLabel = t(project.pinned ? 'shell.switcher.unpin' : 'shell.switcher.pin', { name: project.name })
                return (
                  <div key={project.id} className={cx('flex items-center rounded-md transition-colors', current ? 'bg-accent-wash' : 'hover:bg-surface-high')}>
                    <button type="button" data-project-choice aria-current={current ? true : undefined} onClick={() => { onSelect(project); setOpen(false); setQuery('') }} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm">
                      <ProjectAvatar project={project} /><span className="flex-1 truncate">{project.name}</span>
                      {tone ? <span aria-hidden className={cx('nav-inline-dot', `nav-tone-${tone}`)} /> : null}
                      {current && <Check size={14} className="shrink-0 text-accent" />}
                    </button>
                    <TooltipButton type="button" aria-label={pinLabel} aria-pressed={project.pinned} onClick={() => togglePin.mutate({ id: project.id, pinned: !project.pinned })} className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-ink-faint hover:text-accent"><Pin size={14} className={project.pinned ? 'fill-accent text-accent' : undefined} /></TooltipButton>
                  </div>
                )
              })}
            </div>)}
            {matches.length === 0 && <p role="status" className="px-2 py-6 text-center text-sm text-ink-faint">{t('shell.switcher.empty')}</p>}
          </div>
          <button type="button" onClick={() => { navigate('/projects/new'); setOpen(false); onNavigate() }} className="flex min-h-11 shrink-0 items-center gap-2 border-t border-line px-4 text-sm text-ink-soft hover:bg-surface-high"><FolderPlus size={15} />{t('projects.create.title')}</button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
