import * as Dialog from '@radix-ui/react-dialog'
import { Check, ChevronDown, Layers, Search, X } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import type { ProjectDto } from '@sillage/protocol'
import { useTranslate } from '../lib/i18n'
import { scoreMatch } from '../lib/search'
import { ProjectAvatar } from './ProjectAvatar'
import { Button, cx, IconButton } from './ui'

export interface ProjectOption {
  value: string
  label: string
  project?: Pick<ProjectDto, 'image' | 'color'>
}

type Props = {
  // Callers supply only eligible projects; global/unknown scopes retain their own values.
  options: ProjectOption[]
  label: string
  disabled?: boolean
  className?: string
} & (
  | { multiple?: false; value: string; onChange: (value: string) => void }
  | { multiple: true; value: string[]; onChange: (value: string[]) => void }
)

/** Searchable project choices shared by scope forms, permissions and filters. */
export function ProjectSelector(props: Props) {
  const { options, label, disabled, className } = props
  const t = useTranslate()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const selected = props.multiple ? props.value : [props.value]
  const active = selected.length === 1 ? options.find(option => option.value === selected[0]) : undefined
  const names = selected.map(value => options.find(option => option.value === value)?.label ?? value)
  const summary = names.length > 1 ? t('projectSelector.count', { count: names.length }) : names[0] || t('shell.switcher.choose')
  const matches = options.filter(option => !query.trim() || scoreMatch(option.label, query.trim()) !== null)
  const choose = (value: string) => {
    if (props.multiple) props.onChange(selected.includes(value) ? selected.filter(id => id !== value) : [...selected, value])
    else { props.onChange(value); setOpen(false) }
  }
  return <div className={cx('flex min-w-0 flex-col gap-1.5', className)}>
    <span id={id} className="text-sm font-medium text-ink-soft">{label}</span>
    <Dialog.Root open={open} onOpenChange={value => { setOpen(value); setQuery('') }}>
      <Dialog.Trigger asChild>
        <button type="button" disabled={disabled} aria-labelledby={id} aria-describedby={`${id}-value`} className="tap-target flex w-full min-w-0 items-center gap-2 rounded-md border border-line bg-sunken px-3 text-left text-sm hover:border-line-strong disabled:opacity-45">
          {active?.project
            ? <ProjectAvatar project={active.project} /> : <Layers size={16} className="shrink-0 text-ink-faint" />}
          <span id={`${id}-value`} className="min-w-0 flex-1 truncate">{summary}</span><ChevronDown size={16} className="shrink-0 text-ink-faint" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content aria-describedby={undefined} className="fixed top-[10dvh] left-1/2 z-50 flex max-h-[80dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-float">
          <div className="flex items-center justify-between gap-3 px-4 pt-3"><Dialog.Title className="text-sm font-semibold">{label}</Dialog.Title><Dialog.Close asChild><IconButton label={t('common.close')}><X size={16} /></IconButton></Dialog.Close></div>
          <div className="m-3 flex shrink-0 items-center gap-2 rounded-md border border-line bg-sunken px-3">
            <Search size={16} className="text-ink-faint" />
            <input autoFocus value={query} onChange={event => setQuery(event.target.value)} aria-label={t('shell.switcher.search')} placeholder={t('shell.switcher.search')} className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none" onKeyDown={event => {
              if (event.nativeEvent.isComposing) return
              const first = list.current?.querySelector<HTMLButtonElement>('button')
              if (event.key === 'ArrowDown') { event.preventDefault(); first?.focus() }
              if (event.key === 'Enter') { event.preventDefault(); first?.click() }
            }} />
          </div>
          <div ref={list} role={props.multiple ? 'group' : 'radiogroup'} aria-label={label} className="min-h-0 overflow-y-auto px-2 pb-2" onKeyDown={event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            const choices = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
            const index = choices.indexOf(event.target as HTMLButtonElement)
            if (index < 0) return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length
            choices[next]?.focus()
          }}>
            {matches.map(option => <button key={option.value} type="button" role={props.multiple ? 'checkbox' : 'radio'} aria-checked={selected.includes(option.value)} onClick={() => choose(option.value)} className={cx('flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent', selected.includes(option.value) ? 'bg-accent-wash' : 'hover:bg-surface-high')}>
              {option.project ? <ProjectAvatar project={option.project} /> : <Layers size={16} className="shrink-0 text-ink-faint" />}
              <span className="min-w-0 flex-1 break-words">{option.label}</span><span className="w-4 shrink-0 text-accent">{selected.includes(option.value) ? <Check size={16} /> : null}</span>
            </button>)}
            {matches.length === 0 && <p role="status" className="px-3 py-6 text-center text-sm text-ink-faint">{t('shell.switcher.empty')}</p>}
          </div>
          {props.multiple && <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line p-3">
            <span role="status" className="text-xs text-ink-soft">{t('projectSelector.count', { count: selected.length })}</span>
            <Dialog.Close asChild><Button>{t('common.close')}</Button></Dialog.Close>
          </div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    {props.multiple && names.length > 0 && <p className="max-h-20 overflow-y-auto break-words text-xs text-ink-soft">{names.join(', ')}</p>}
  </div>
}
