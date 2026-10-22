import * as RadixPopover from '@radix-ui/react-popover'
import type { ReactNode } from 'react'
import { cx } from './cx'

interface PopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactNode
  children: ReactNode
  /** Panel name when no persistent heading is visible. */
  label: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'end'
  onEscapeKeyDown?: (event: KeyboardEvent) => void
  /** Intercept Radix focus return to send it somewhere besides the trigger. */
  onCloseAutoFocus?: (event: Event) => void
  className?: string
}

/**
 * Free-content anchored panel, distinct from Menu whose menuitem-only roving tabindex excludes
 * ordinary buttons and treats Tab as closure. Navigable panels require a shell without menu
 * semantics.
 */
export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  label,
  side = 'top',
  align = 'start',
  onEscapeKeyDown,
  onCloseAutoFocus,
  className,
}: PopoverProps) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={12}
          aria-label={label}
          onEscapeKeyDown={onEscapeKeyDown}
          onCloseAutoFocus={onCloseAutoFocus}
          className={cx(
            'z-50 flex flex-col overflow-hidden outline-none',
            'surface rounded-xl border border-line shadow-pop',
            className,
          )}
          // Bound height by actual above-trigger space measured by Radix; constants overflow short windows.
          style={{ maxHeight: 'var(--radix-popover-content-available-height)' }}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  )
}
