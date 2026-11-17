import { useCliUpdateNotice } from '../lib/agents'
import { createContext, useContext } from 'react'
import { Menu, PanelLeftOpen } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { useTranslate } from '../lib/i18n'
import { hasColumn, routeSpace } from '../lib/nav-space'
import { setNavColumnFolded, useNavColumnFolded } from '../lib/sidebar'
import { useUpdateNotice } from '../lib/system'
import { IconButton } from './ui'
import { UpdateDot } from './UpdateDot'

export const MobileNavigationContext = createContext<() => void>(() => {})

/**
 * Beside the page, the way back to a folded column: at the header's leading corner, where the
 * column was. Nothing on a phone, whose drawer has no folded state, nor in a space without a list.
 */
export function NavColumnUnfoldButton() {
  const t = useTranslate()
  const folded = useNavColumnFolded()
  const space = routeSpace(useLocation().pathname)
  if (!folded || !space || !hasColumn(space)) return null
  return (
    <IconButton label={t('shell.column.unfold')} onClick={() => setNavColumnFolded(false)} data-nav-unfold className="max-md:hidden">
      <PanelLeftOpen size={18} />
    </IconButton>
  )
}

/** Navigation access follows each screen's header: the drawer on a phone, the folded column beside the page. */
export function MobileNavigationButton({ drawerOnly = false }: {
  /** For a bar that only exists on a phone, where a column never folds. */
  drawerOnly?: boolean
}) {
  const open = useContext(MobileNavigationContext)
  const t = useTranslate()
  // The collapsed phone sidebar's badge must also appear on its visible toggle.
  const appUpdateNotice = useUpdateNotice()
  const cliUpdateNotice = useCliUpdateNotice()
  const updateNotice = appUpdateNotice || cliUpdateNotice
  return (<>
    {drawerOnly ? null : <NavColumnUnfoldButton />}
    <IconButton
      label={updateNotice ? `${t('shell.nav.open')} · ${t('about.badge.updateAvailable')}` : t('shell.nav.open')}
      onClick={open}
      data-navigation-trigger
      aria-haspopup="dialog"
      className="md:hidden"
    >
      <span className="relative">
        <Menu size={20} />
        {updateNotice ? <UpdateDot /> : null}
      </span>
    </IconButton>
  </>)
}
