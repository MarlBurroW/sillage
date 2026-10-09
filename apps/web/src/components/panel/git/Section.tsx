import { ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { cx } from '../../ui'

/**
 * Une section dépliable de l'onglet Git.
 *
 * L'onglet empile ce qu'un client git montre en colonnes : les changements, les
 * branches, les stashs, les commits. Dans un panneau qui fait parfois 390 px de large,
 * tout ouvrir d'un coup noierait ce qu'on cherche ; chaque section se replie, et retient
 * son état d'une ouverture à l'autre.
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
  /** Décompte à côté du titre. Zéro n'affiche rien. */
  count?: number
  open: boolean
  onToggle: () => void
  /** Boutons propres à la section, à droite du titre. Toujours visibles, repliée ou non. */
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="shrink-0">
      <div className="surface sticky top-0 z-10 flex items-center gap-1 border-b border-line py-0.5 pr-1 pl-1.5">
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
          <span className="truncate text-[0.6875rem] font-semibold tracking-wide text-ink-faint uppercase">
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
 * Ouverture d'une section, retenue entre les sessions.
 *
 * Partagée entre toutes les portées : qui replie les branches le fait par goût, pas pour
 * un dépôt en particulier.
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
      /* Un stockage plein n'empêche pas de plier la section pour cette fois. */
    }
  }, [name, open])

  const toggle = useCallback(() => setOpen((value) => !value), [])
  return [open, toggle]
}
