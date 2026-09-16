import { createContext, useContext } from 'react'
import { Menu } from 'lucide-react'
import { useTranslate } from '../lib/i18n'
import { IconButton } from './ui'

export const MobileNavigationContext = createContext<() => void>(() => {})

/** L'accès à la navigation suit l'en-tête de l'écran sur téléphone. */
export function MobileNavigationButton() {
  const open = useContext(MobileNavigationContext)
  const t = useTranslate()
  return (
    <IconButton
      label={t('shell.nav.open')}
      onClick={open}
      data-navigation-trigger
      aria-haspopup="dialog"
      className="md:hidden"
    >
      <Menu size={20} />
    </IconButton>
  )
}
