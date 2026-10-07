import * as RadixTooltip from '@radix-ui/react-tooltip'
import { createContext, useContext, type ComponentPropsWithRef, type ReactElement, type ReactNode } from 'react'
import { useMediaQuery } from '../../lib/viewport'

const TooltipEnabled = createContext(true)

export function TooltipProvider({ children }: { children: ReactNode }) {
  // Le focus automatique des panneaux ne doit pas produire une aide collante au doigt.
  const enabled = useMediaQuery('(hover: hover) and (pointer: fine)')
  return <TooltipEnabled.Provider value={enabled}>
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={150}>{children}</RadixTooltip.Provider>
  </TooltipEnabled.Provider>
}

/** Le portail évite de couper l'aide dans les panneaux et les listes défilantes. */
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

/** Conserve le style et la ref du bouton, notamment quand il ouvre un menu Radix. */
export function TooltipButton({ title, ...props }: ComponentPropsWithRef<'button'>) {
  const label = title ?? props['aria-label']
  const button = <button {...props} />
  return label ? <Tooltip label={label}>{button}</Tooltip> : button
}
