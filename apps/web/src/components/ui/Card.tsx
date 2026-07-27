import type { ReactNode } from 'react'
import { cx } from './cx'

interface CardProps {
  children: ReactNode
  className?: string
}

export function Card({ children, className }: CardProps) {
  return (
    <div className={cx('surface rounded-lg border border-line shadow-card', className)}>
      {children}
    </div>
  )
}

interface CardHeaderProps {
  title: string
  description?: string
  icon?: ReactNode
  actions?: ReactNode
}

export function CardHeader({ title, description, icon, actions }: CardHeaderProps) {
  return (
    <div className="flex items-start gap-3 border-b border-line px-5 py-4">
      {icon ? (
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-wash text-accent">
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <h2 className="text-[0.9375rem] leading-tight font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-1 text-sm text-ink-faint">{description}</p> : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  )
}

export function CardBody({ children, className }: CardProps) {
  return <div className={cx('px-5 py-4', className)}>{children}</div>
}
