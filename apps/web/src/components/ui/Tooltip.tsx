import * as RadixTooltip from '@radix-ui/react-tooltip'
import { createContext, useContext, type ComponentPropsWithRef, type ReactElement, type ReactNode } from 'react'
import { useMediaQuery } from '../../lib/viewport'

const TooltipEnabled = createContext(true)

export function TooltipProvider({ children }: { children: ReactNode }) {
  // Automatic panel focus must not leave sticky touch tooltips.
  const enabled = useMediaQuery('(hover: hover) and (pointer: fine)')
  return <TooltipEnabled.Provider value={enabled}>
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={150}>{children}</RadixTooltip.Provider>
  </TooltipEnabled.Provider>
}

/** Portals prevent clipping within panels and scrolling lists. */
export function Tooltip({ label, children }: { label: string; children: ReactElement }) {
  const enabled = useContext(TooltipEnabled)
  if (!enabled) return children
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content side="top" sideOffset={6} collisionPadding={8}
          className="surface z-[100] max-w-[min(22rem,calc(100vw-1rem))] rounded-md border border-line px-2.5 py-1.5 text-xs leading-relaxed text-ink shadow-pop">
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
