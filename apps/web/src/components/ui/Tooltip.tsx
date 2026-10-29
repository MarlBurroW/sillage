import * as RadixTooltip from '@radix-ui/react-tooltip'
import { createContext, useContext, useState, type ComponentPropsWithRef, type ReactElement, type ReactNode } from 'react'
import { useMediaQuery } from '../../lib/viewport'
import { cx } from './cx'

const TooltipEnabled = createContext(true)

export function TooltipProvider({ children, delayDuration = 400 }: { children: ReactNode; delayDuration?: number }) {
  // Automatic panel focus must not leave sticky touch tooltips.
  const enabled = useMediaQuery('(hover: hover) and (pointer: fine)')
  return <TooltipEnabled.Provider value={enabled}>
    <RadixTooltip.Provider delayDuration={delayDuration} skipDelayDuration={150}>{children}</RadixTooltip.Provider>
  </TooltipEnabled.Provider>
}

/** Portals prevent clipping within panels and scrolling lists. */
export function Tooltip({ label, children, side = 'top', sideOffset = 6, className, disabled }: {
  label: ReactNode
  children: ReactElement
  side?: 'top' | 'bottom' | 'left' | 'right'
  sideOffset?: number
  className?: string
  disabled?: boolean
}) {
  const enabled = useContext(TooltipEnabled)
  const [open, setOpen] = useState(false)
  if (!enabled) return children
  return (
    <RadixTooltip.Root {...(disabled === undefined ? {} : { open: !disabled && open, onOpenChange: (value: boolean) => setOpen(!disabled && value) })}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content side={side} sideOffset={sideOffset} collisionPadding={8}
          className={cx('surface z-[100] max-w-[min(22rem,calc(100vw-1rem))] rounded-md border border-line px-2.5 py-1.5 text-xs leading-relaxed text-ink shadow-pop', className)}>
          {label}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}

/** Preserve button styles and refs, especially Radix menu triggers. */
export function TooltipButton({ title, ...props }: ComponentPropsWithRef<'button'>) {
  const label = title ?? props['aria-label']
  const button = <button {...props} />
  return label ? <Tooltip label={label}>{button}</Tooltip> : button
}
