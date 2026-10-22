import { cx } from '../ui'

/**
 * Composer buttons: 44px for desktop touch, 32px mouse. Phones use 36px visible buttons to fit one
 * line with invisible padding retaining 44px touch targets.
 */
export function toolButtonClass(narrow: boolean): string {
  return cx(
    'flex shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors',
    'hover:bg-surface-high hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
    'data-[state=open]:bg-surface-high data-[state=open]:text-ink disabled:pointer-events-none disabled:opacity-45',
    narrow ? 'relative size-9 before:absolute before:-inset-1 before:content-[""]' : 'size-11 md:size-8 pointer-coarse:size-11',
  )
}
