import { LoaderCircle } from 'lucide-react'
import type { ButtonHTMLAttributes, ComponentPropsWithRef, ReactNode } from 'react'
import { TooltipButton } from './Tooltip'
import { cx } from './cx'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'gradient-accent text-accent-ink shadow-card hover:brightness-110',
  secondary: 'surface border border-line text-ink hover:border-line-strong',
  ghost: 'text-ink-soft hover:bg-surface-high hover:text-ink',
  danger: 'text-critical hover:bg-critical/12',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-11 px-3 text-sm gap-1.5 md:h-9 pointer-coarse:h-11',
  md: 'tap-target px-4 text-sm gap-2',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  busy?: boolean
}

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  busy = false,
  children,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={busy || props.disabled}
      aria-busy={busy || props['aria-busy']}
      className={cx(
        'inline-flex items-center justify-center rounded-md font-medium whitespace-nowrap',
        'transition-[background,border-color,filter,color] duration-150',
        'disabled:pointer-events-none',
        busy ? 'cursor-wait' : 'disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    >
      {busy ? <LoaderCircle size={16} aria-hidden="true" className="shrink-0 motion-safe:animate-spin" /> : icon}
      {children}
    </button>
  )
}

interface IconButtonProps extends ComponentPropsWithRef<'button'> {
  /** Required accessible label for textless buttons. */
  label: string
  /** md meets 44px touch targets; sm is for dense lists. */
  size?: 'sm' | 'md'
  children: ReactNode
}

// Size classes supplied through className cannot reliably override because Tailwind orders
// utilities independently of string order.
const ICON_SIZES = { sm: 'size-11 md:size-7 pointer-coarse:size-11', md: 'size-11' } as const

export function IconButton({ label, size = 'md', children, className, ...props }: IconButtonProps) {
  return (
    <TooltipButton
      {...props}
      aria-label={label}
      title={props.title ?? label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-md',
        'text-ink-faint transition-colors hover:bg-surface-high hover:text-ink',
        'disabled:pointer-events-none disabled:opacity-45',
        ICON_SIZES[size],
        className,
      )}
    >
      {children}
    </TooltipButton>
  )
}
