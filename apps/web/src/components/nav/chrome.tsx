import { PanelLeftClose, X } from 'lucide-react'
import { createContext, useContext, type ReactNode } from 'react'
import { useTranslate } from '../../lib/i18n'
import { IconButton } from '../ui'

/** What every column needs from the shell, without threading it through each list. */
export type NavChrome = {
  /** Persistent navigation beside the page; false for the phone drawer. */
  wide: boolean
  /** A destination was chosen: the phone drawer closes. */
  onNavigate: () => void
  onFold: () => void
  onClose: () => void
}

export const NavChromeContext = createContext<NavChrome>({ wide: true, onNavigate: () => {}, onFold: () => {}, onClose: () => {} })

export function useNavChrome(): NavChrome {
  return useContext(NavChromeContext)
}

/**
 * Column heading: the space's name, its own actions, then the control that puts the column away.
 * Same place in every space, so the way out never moves.
 */
export function ColumnHead({ title, lead, actions }: { title: ReactNode; lead?: ReactNode; actions?: ReactNode }) {
  const t = useTranslate()
  const { wide, onFold, onClose } = useNavChrome()
  return (
    <div className="nav-column-head">
      {lead}
      <h2>{title}</h2>
      <span className="nav-column-actions">
        {actions}
        {wide
          ? <IconButton size="sm" label={t('shell.column.fold')} onClick={onFold}><PanelLeftClose size={17} /></IconButton>
          : <IconButton label={t('shell.nav.close')} onClick={onClose}><X size={18} /></IconButton>}
      </span>
    </div>
  )
}

/** List heading inside a column: a name, how many, and the list's own actions. */
export function ColumnHeading({ label, count, tone, children }: { label: string; count?: number; tone?: 'caution'; children?: ReactNode }) {
  return (
    <div className="sidebar-sessions-heading">
      <span>{label}{count === undefined ? null : <span className={tone === 'caution' ? 'nav-count nav-count-caution' : 'nav-count'}>{count}</span>}</span>
      {children}
    </div>
  )
}
