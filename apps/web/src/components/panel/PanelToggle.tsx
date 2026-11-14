import { PanelRight } from 'lucide-react'
import type { ButtonHTMLAttributes } from 'react'
import { useTranslate } from '../../lib/i18n'
import { setPanelOpen, usePanelOpen } from '../../lib/panel'
import { IconButton, cx } from '../ui'

/**
 * The one control that opens and closes the right panel, last in every header that carries it: the
 * page's and the panel's own. Each header places it with its centre 26px from the top and right
 * edges, so the panel's toggle arrives under the pointer that opened it and a second click closes.
 * Kept apart from `SidePanel`, which loads lazily: the page needs this before the panel's code.
 */
export function PanelToggle({ page = false, replaced = false, className, ...props }: {
  /**
   * In a page header rather than the panel's. An open panel covers this one or stands beside it
   * with its own, so the page's copy leaves the tab order and the accessibility tree meanwhile.
   */
  page?: boolean
  /**
   * The panel stands beside the page instead of covering it, and its toggle takes over at the
   * window's edge. Faded rather than removed: the header keeps its layout and focus can return
   * here on closing.
   */
  replaced?: boolean
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick'>) {
  const t = useTranslate()
  const open = usePanelOpen()
  const covered = page && open
  return (
    <IconButton
      {...props}
      label={t(open ? 'conversation.panel.close' : 'conversation.panel.open')}
      aria-hidden={covered || undefined}
      tabIndex={covered ? -1 : undefined}
      // The docked panel moves the page's copy away from the pointer without a leave event, which
      // would strand its tooltip beside the thread.
      tooltipDisabled={page ? covered || replaced : undefined}
      onClick={() => setPanelOpen(!open)}
      className={cx(replaced && 'pointer-events-none opacity-0', className)}
    >
      <PanelRight size={18} className={cx(open && 'text-accent')} />
    </IconButton>
  )
}
