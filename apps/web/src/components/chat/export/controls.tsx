import { useRef, type ReactNode } from 'react'
import { cx } from '../../ui'

export const textareaClass = 'w-full min-h-24 rounded-md border border-line bg-sunken px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none'

export function CheckField({ checked, onChange, children, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return <label className={cx('flex min-h-11 items-center gap-2 text-sm text-ink-soft', disabled && 'opacity-50')}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} className="size-4 shrink-0 accent-[var(--sg-accent)]" />
    {children}
  </label>
}

export function ExportTabs<T extends string>({ id, label, value, onChange, tabs }: {
  id: string; label: string; value: T; onChange: (value: T) => void; tabs: { value: T; label: string }[]
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  return <div className="flex shrink-0 gap-4 border-b border-line" role="tablist" aria-label={label}>
    {tabs.map((tab, index) => <button key={tab.value} ref={element => { refs.current[index] = element }} type="button" role="tab"
      id={id + '-' + tab.value} aria-controls={id + '-panel'} aria-selected={value === tab.value} tabIndex={value === tab.value ? 0 : -1}
      className={cx('min-h-11 border-b-2 px-1 text-sm focus-visible:outline-2 focus-visible:outline-accent', value === tab.value ? 'border-accent text-ink' : 'border-transparent text-ink-faint')}
      onClick={() => onChange(tab.value)} onKeyDown={event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
        if (next === null) return
        event.preventDefault(); onChange(tabs[next]!.value); refs.current[next]?.focus()
      }}>{tab.label}</button>)}
  </div>
}
