import type { ReactNode } from 'react'
import { TooltipButton } from './Tooltip'
import { cx } from './cx'

export interface Segment<T extends string> {
  value: T
  /** Accessible name, shown as a tooltip when the segment is an icon. */
  label: string
  icon?: ReactNode
  /** Visible text; an icon alone is enough when the choices are a familiar set. */
  text?: string
}

/**
 * One choice among a few, all visible: a view mode, a size. A radio group, so arrows move the
 * choice like any other. Prefer Select past five options.
 */
export function Segmented<T extends string>({ label, value, onChange, options, className }: {
  label: string
  value: T
  onChange: (value: T) => void
  options: Segment<T>[]
  className?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx('inline-flex shrink-0 items-center gap-0.5 rounded-md border border-line bg-sunken p-0.5', className)}
      onKeyDown={(event) => {
        const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
        if (!step) return
        event.preventDefault()
        const index = options.findIndex((option) => option.value === value)
        const next = options[(index + step + options.length) % options.length]
        if (!next) return
        onChange(next.value)
        ;(event.currentTarget.querySelector(`[data-segment="${next.value}"]`) as HTMLElement | null)?.focus()
      }}
    >
      {options.map((option) => (
        <TooltipButton
          key={option.value}
          type="button"
          role="radio"
          data-segment={option.value}
          aria-checked={value === option.value}
          aria-label={option.label}
          // The visible text already says it: a tooltip would repeat the button.
          tooltipDisabled={option.text ? true : undefined}
          tabIndex={value === option.value ? 0 : -1}
          onClick={() => onChange(option.value)}
          className={cx(
            'inline-flex h-10 min-w-10 items-center justify-center gap-1.5 rounded px-2 text-xs font-medium transition-colors md:h-7 md:min-w-7 pointer-coarse:h-10 pointer-coarse:min-w-10',
            value === option.value ? 'surface text-ink shadow-card' : 'text-ink-faint hover:text-ink',
          )}
        >
          {option.icon}
          {option.text ? <span>{option.text}</span> : null}
        </TooltipButton>
      ))}
    </div>
  )
}
