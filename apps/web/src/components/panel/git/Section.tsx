import { ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { cx } from '../../ui'

/**
 * Collapsible Git section. Stack the changes/branches/stashes/commits that desktop Git clients
 * place in columns. Sometimes only 390px wide, the panel needs independent remembered collapse
 * state to avoid overwhelming users.
 */
export function Section({
  title,
  count,
  open,
  onToggle,
  actions,
  children,
}: {
  title: string
  /** Count beside title; zero displays nothing. */
  count?: number
  open: boolean
  onToggle: () => void
  /** Section buttons right of title, visible whether collapsed or expanded. */
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="shrink-0">
      <div className="git-section-heading surface sticky top-0 z-10 flex items-center gap-1 border-b border-line py-0.5 pr-1 pl-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left hover:bg-surface-high"
        >
          <ChevronRight
            size={12}
            className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')}
          />
          <span className="truncate text-[0.6875rem] font-semibold text-ink-soft">
            {title}
          </span>
          {count ? (
            <span className="shrink-0 rounded-full bg-surface-high px-1.5 text-[0.625rem] tabular-nums text-ink-faint">
              {count}
            </span>
          ) : null}
        </button>
        {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
      </div>
      {open ? children : null}
    </section>
  )
}

const STORAGE_KEY = 'sillage.git.sections'

function readStates(): Record<string, boolean> {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown
    return stored && typeof stored === 'object' ? (stored as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

/**
 * Persist section state across sessions and scopes: collapsing branches expresses preference rather
 * than repository-specific behavior.
 */
export function useSectionOpen(name: string, fallback: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(() => readStates()[name] ?? fallback)

  useEffect(() => {
    const states = readStates()
    if (states[name] === open) return
    states[name] = open
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(states))
    } catch {
      /* Full storage must not prevent collapsing for the current visit. */
    }
  }, [name, open])

  const toggle = useCallback(() => setOpen((value) => !value), [])
  return [open, toggle]
}
