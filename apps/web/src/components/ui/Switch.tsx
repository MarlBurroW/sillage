import { TooltipButton } from './Tooltip'
import { cx } from './cx'

/**
 * Immediate two-state setting. Unlike Disable buttons, switches show both the action and current
 * state, allowing cross-row comparison. Reserve for immediate application; saved forms should use
 * checkboxes.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Required accessible name because switches contain no text. */
  label: string
  disabled?: boolean
}) {
  return (
    <TooltipButton
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cx(
        // Same target as IconButton: 44px on touch, denser with mouse.
        'flex size-11 shrink-0 items-center justify-center rounded-md md:h-7 md:w-9 pointer-coarse:size-11',
        'focus-visible:outline-2 focus-visible:outline-accent',
        'disabled:pointer-events-none disabled:opacity-45',
      )}
    >
      <span
        aria-hidden
        className={cx(
          'flex h-5 w-8 items-center rounded-full p-0.5 transition-colors',
          checked ? 'justify-end bg-accent' : 'bg-line-strong',
        )}
      >
        <span className="size-4 rounded-full bg-surface shadow-sm" />
      </span>
    </TooltipButton>
  )
}
