import * as RadixPopover from '@radix-ui/react-popover'
import type { ReactElement, ReactNode } from 'react'
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
  /**
   * Place the panel against a wider element holding the trigger, when the trigger itself may move:
   * given the wired trigger, returns that element.
   */
  frame?: (trigger: ReactElement) => ReactElement
  onEscapeKeyDown?: (event: KeyboardEvent) => void
  /** Intercept Radix opening focus: a field focused on touch would raise the keyboard unasked. */
  onOpenAutoFocus?: (event: Event) => void
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
  frame,
  onEscapeKeyDown,
  onOpenAutoFocus,
  onCloseAutoFocus,
  className,
}: PopoverProps) {
  const wired = <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      {frame ? <RadixPopover.Anchor asChild>{frame(wired)}</RadixPopover.Anchor> : wired}
      <RadixPopover.Portal>
        <RadixPopover.Content
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={12}
          aria-label={label}
          onEscapeKeyDown={onEscapeKeyDown}
          onOpenAutoFocus={onOpenAutoFocus}
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
