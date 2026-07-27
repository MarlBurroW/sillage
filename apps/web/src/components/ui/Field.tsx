import { useId, type InputHTMLAttributes, type ReactNode } from 'react'
import { cx } from './cx'

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string
  hint?: string
  error?: string
  icon?: ReactNode
}

export function Field({ label, hint, error, icon, className, ...props }: FieldProps) {
  const id = useId()
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink-soft">
        {label}
      </label>

      <div
        className={cx(
          'tap-target flex items-center gap-2 rounded-md border bg-sunken px-3',
          'transition-colors focus-within:border-accent',
          error ? 'border-critical' : 'border-line hover:border-line-strong',
        )}
      >
        {icon ? <span className="shrink-0 text-ink-faint">{icon}</span> : null}
        <input
          {...props}
          id={id}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={cx(
            'min-w-0 flex-1 bg-transparent text-sm text-ink outline-none',
            'placeholder:text-ink-faint',
            className,
          )}
        />
      </div>

      {error ? (
        <p id={`${id}-error`} className="text-xs text-critical">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-ink-faint">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
