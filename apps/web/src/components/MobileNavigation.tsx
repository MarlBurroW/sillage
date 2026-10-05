import { createContext, useContext } from 'react'
import { Menu } from 'lucide-react'
import { useTranslate } from '../lib/i18n'
import { useUpdateNotice } from '../lib/system'
import { IconButton } from './ui'
import { UpdateDot } from './UpdateDot'

export const MobileNavigationContext = createContext<() => void>(() => {})

/** L'accès à la navigation suit l'en-tête de l'écran sur téléphone. */
export function MobileNavigationButton() {
  const open = useContext(MobileNavigationContext)
  const t = useTranslate()
  // Au téléphone, la barre latérale est repliée derrière ce bouton : sa pastille
  // serait invisible si celui-ci ne la reprenait pas.
  const updateNotice = useUpdateNotice()
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
