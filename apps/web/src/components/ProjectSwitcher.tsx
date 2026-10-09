import { TooltipButton } from './ui/Tooltip'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, ChevronsUpDown, FolderPlus, Layers, Search, SlidersHorizontal, Star, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ProjectDto } from '@sillage/protocol'
import { useTranslate } from '../lib/i18n'
import { projectViewPath, useProjectView } from '../lib/project-view'
import { useTogglePin } from '../lib/projects'
import { scoreMatch } from '../lib/search'
import { ProjectAvatar } from './ProjectAvatar'
import { cx, IconButton } from './ui'

export function ProjectSwitcher({ projects, selected, all, onAll, onSelect, recent, userId, onNavigate }: {
  projects: ProjectDto[]
  selected?: ProjectDto
  all: boolean
  onAll: () => void
  onSelect: (project: ProjectDto, fallback: string) => void
  recent: string[]
  userId: string
  onNavigate: () => void
}) {
  const t = useTranslate()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const togglePin = useTogglePin()
  // Les épingles vivaient dans le navigateur : celles d'avant sont poussées au serveur
  // une fois, puis la clé locale disparaît pour que la migration ne rejoue pas.
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
    } catch { /* Stockage facultatif. */ }
    // Une seule passe par compte : relancer à chaque changement de liste réépinglerait.
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
      <div className="mb-2 flex items-center gap-1">
      <Dialog.Trigger asChild>
        <button type="button" aria-label={t('shell.switcher.choose')} className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-line bg-surface-high px-3 text-left hover:border-ink-faint">
          {all ? <Layers size={16} /> : <ProjectAvatar project={selected} className="size-5" />}
          <span className="min-w-0 flex-1"><span className="block text-[0.625rem] text-ink-faint">{t('shell.switcher.workspace')}</span><span className="block truncate text-sm font-semibold">{all ? t('shell.switcher.all') : selected?.name ?? t('shell.switcher.choose')}</span></span>
          <ChevronsUpDown size={14} className="shrink-0 text-ink-faint" />
        </button>
      </Dialog.Trigger>
      {!all && selected && <IconButton label={t('shell.project.settings')} onClick={() => { navigate(`/p/${selected.id}`); onNavigate() }}><SlidersHorizontal size={16} /></IconButton>}
      </div>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content aria-describedby={undefined} className="fixed top-[10dvh] left-1/2 z-50 flex max-h-[80dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-float">
          <div className="flex items-center justify-between px-4 pt-3"><Dialog.Title className="text-sm font-semibold">{t('shell.switcher.choose')}</Dialog.Title><Dialog.Close asChild><IconButton label={t('common.close')}><X size={16} /></IconButton></Dialog.Close></div>
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
            {!query.trim() && <button type="button" onClick={() => { onAll(); setOpen(false) }} className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-sm hover:bg-surface-high"><Layers size={15} /><span className="flex-1 text-left">{t('shell.switcher.all')}</span>{all && <Check size={15} />}</button>}
            {groups.map((group) => group.entries.length > 0 && <div key={group.label}>
              <p className="px-2 pt-3 pb-1 text-[0.6875rem] font-semibold text-ink-faint">{group.label}</p>
              {group.entries.map((project) => <ProjectChoice key={project.id} project={project} selected={!all && selected?.id === project.id} pinned={project.pinned} onPin={() => togglePin.mutate({ id: project.id, pinned: !project.pinned })} onSelect={(fallback) => { onSelect(project, fallback); setOpen(false); setQuery('') }} />)}
            </div>)}
            {matches.length === 0 && <p role="status" className="px-2 py-6 text-center text-sm text-ink-faint">{t('shell.switcher.empty')}</p>}
          </div>
          <button type="button" onClick={() => { navigate('/projects/new'); setOpen(false); onNavigate() }} className="flex min-h-11 shrink-0 items-center gap-2 border-t border-line px-4 text-sm text-ink-soft hover:bg-surface-high"><FolderPlus size={15} />{t('projects.create.title')}</button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ProjectChoice({ project, selected, pinned, onPin, onSelect }: { project: ProjectDto; selected: boolean; pinned: boolean; onPin: () => void; onSelect: (fallback: string) => void }) {
  const t = useTranslate()
  const view = useProjectView(project.id)
  return <div className={cx('flex items-center rounded-md transition-colors', selected ? 'bg-accent-wash' : 'hover:bg-surface-high')}>
    <button type="button" data-project-choice aria-current={selected ? true : undefined} onClick={() => onSelect(projectViewPath(project.id, view))} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm"><ProjectAvatar project={project} /><span className="flex-1 truncate">{project.name}</span>{selected && <Check size={14} className="shrink-0 text-accent" />}</button>
    <TooltipButton type="button" aria-label={t(pinned ? 'shell.switcher.unpin' : 'shell.switcher.pin', { name: project.name })} title={t(pinned ? 'shell.switcher.unpin' : 'shell.switcher.pin', { name: project.name })} onClick={onPin} className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-ink-faint hover:text-accent"><Star size={14} className={pinned ? 'fill-accent text-accent' : undefined} /></TooltipButton>
  </div>
}
