import { useCliUpdateNotice } from '../lib/agents'
import { createContext, useContext } from 'react'
import { Menu } from 'lucide-react'
import { useTranslate } from '../lib/i18n'
import { useUpdateNotice } from '../lib/system'
import { IconButton } from './ui'
import { UpdateDot } from './UpdateDot'

export const MobileNavigationContext = createContext<() => void>(() => {})

/** Phone navigation access follows each screen's header. */
export function MobileNavigationButton() {
  const open = useContext(MobileNavigationContext)
  const t = useTranslate()
  // The collapsed phone sidebar's badge must also appear on its visible toggle.
  const appUpdateNotice = useUpdateNotice()
  const cliUpdateNotice = useCliUpdateNotice()
  const updateNotice = appUpdateNotice || cliUpdateNotice
  return (
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
  )
}
