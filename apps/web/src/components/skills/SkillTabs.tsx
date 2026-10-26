import { useId, type ReactNode } from 'react'
import { cx } from '../ui'

/** Keep one list per panel and make every section reachable without scrolling past another. */
export function SkillTabs<T extends string>({ label, tabs, value, onChange, children }: {
  label: string
  tabs: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  children: ReactNode
}) {
  const id = useId()
  return <div className="flex min-w-0 flex-col gap-4">
    <div role="tablist" aria-label={label} className="sticky top-0 z-10 grid auto-cols-fr grid-flow-col border-b border-line bg-surface">
      {tabs.map((tab, index) => <button key={tab.value} type="button" role="tab"
        id={`${id}-${tab.value}`} aria-controls={`${id}-panel`} aria-selected={value === tab.value}
        tabIndex={value === tab.value ? 0 : -1}
        onClick={() => onChange(tab.value)}
        onKeyDown={(event) => {
          const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
            : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
          if (next === null) return
          const nextTab = tabs[next]
          if (!nextTab) return
          event.preventDefault()
          onChange(nextTab.value)
          document.getElementById(`${id}-${nextTab.value}`)?.focus()
        }}
        className={cx('min-h-12 border-b-2 px-1 py-2 text-xs font-medium transition-colors sm:px-3 sm:text-sm',
          value === tab.value ? 'border-accent text-accent' : 'border-transparent text-ink-faint hover:text-ink')}>
        {tab.label}
      </button>)}
    </div>
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${value}`} tabIndex={0}>
      {children}
    </div>
  </div>
}
