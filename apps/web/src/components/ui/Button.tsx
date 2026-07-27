import type { ButtonHTMLAttributes, ReactNode } from 'react'
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
  sm: 'h-9 px-3 text-sm gap-1.5',
  md: 'tap-target px-4 text-sm gap-2',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
}

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  children,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex items-center justify-center rounded-md font-medium whitespace-nowrap',
        'transition-[background,border-color,filter,color] duration-150',
        'disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    >
      {icon}
      {children}
    </button>
  )
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Obligatoire : un bouton sans texte doit porter son intitulé pour les lecteurs d'écran. */
  label: string
  /** `md` respecte la cible tactile de 44px ; `sm` est réservé aux listes denses. */
  size?: 'sm' | 'md'
  children: ReactNode
}

// Une classe de taille passée par className ne l'emporterait pas : Tailwind ordonne
// ses utilitaires lui-même, l'ordre dans la chaîne ne décide de rien.
const ICON_SIZES = { sm: 'size-7', md: 'size-11' } as const

export function IconButton({ label, size = 'md', children, className, ...props }: IconButtonProps) {
  return (
    <button
      {...props}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-md',
        'text-ink-faint transition-colors hover:bg-surface-high hover:text-ink',
        'disabled:pointer-events-none disabled:opacity-45',
        ICON_SIZES[size],
        className,
      )}
    >
      {children}
    </button>
  )
}
