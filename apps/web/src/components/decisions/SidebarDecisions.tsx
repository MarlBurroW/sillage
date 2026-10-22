import { CircleHelp } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { useDecisions } from '../../lib/decisions'
import { useTranslate } from '../../lib/i18n'

/** Keep the pending queue visible without repeating its existing page in the sidebar. */
export function SidebarDecisions({ onNavigate }: { onNavigate: () => void }) {
  const t = useTranslate()
  const { data: decisions } = useDecisions('pending')
  if (!decisions?.length) return null
  return <NavLink to="/decisions" onClick={onNavigate} className="sidebar-global-link">
    <CircleHelp size={14} /><span>{t('decision.sidebar.heading')}</span><span className="ml-auto tabular-nums text-caution">{decisions.length}</span>
  </NavLink>
}
