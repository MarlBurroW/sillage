import * as Primitive from '@radix-ui/react-context-menu'
import type { ReactNode } from 'react'
import { cx } from './cx'
import { MenuHint } from './Menu'

/**
 * Right-click menu using a separate primitive: position at the pointer rather than beneath a
 * trigger and support Radix long-press behavior. Styling matches dropdown menus, but entries belong
 * to distinct Radix modules and cannot be shared.
 */
export function ContextMenu({
  trigger,
  disabled = false,
  children,
}: {
  trigger: ReactNode
  /**
   * Disable the trigger without removing the menu tree, useful when touch long-press already drags
   * rows and a visible button offers the same actions.
   */
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Primitive.Root>
      <Primitive.Trigger asChild disabled={disabled}>{trigger}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          className={cx(
            'z-50 min-w-48 overflow-x-hidden overflow-y-auto rounded-lg border border-line p-1',
            'surface shadow-pop',
          )}
          // Scroll long touch menus instead of clipping beyond the screen.
          style={{ maxHeight: 'var(--radix-context-menu-content-available-height)' }}
        >
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  )
}

export function ContextMenuItem({
  icon,
  onSelect,
  tone = 'neutral',
  disabled = false,
  hint,
  children,
}: {
  icon?: ReactNode
  onSelect: () => void
  tone?: 'neutral' | 'critical'
  /** Disable rather than remove, like MenuItem. */
  disabled?: boolean
  /** Equivalent shortcut; see MenuHint. */
  hint?: string
  children: ReactNode
}) {
  return (
    <Primitive.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cx(
        'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
        tone === 'critical'
          ? 'text-critical data-[highlighted]:bg-critical/12'
          : 'text-ink-soft data-[highlighted]:bg-accent-wash data-[highlighted]:text-ink',
      )}
    >
      {icon ? <span className="shrink-0">{icon}</span> : null}
      {children}
      {hint ? <MenuHint>{hint}</MenuHint> : null}
    </Primitive.Item>
  )
}

export function ContextMenuSeparator() {
  return <Primitive.Separator className="my-1 h-px bg-line" />
}

/** Context-menu equivalent of MenuSwatch. */
export function ContextMenuSwatch({
  color,
  selected,
  label,
  onSelect,
}: {
  color: string | null
  selected: boolean
  label: string
  onSelect: () => void
}) {
  return (
    <Primitive.Item asChild onSelect={onSelect}>
      <button
        type="button"
        aria-label={label}
        title={label}
        className={cx(
          'size-5 shrink-0 cursor-pointer rounded-full outline-none transition-transform',
          'hover:scale-110 focus-visible:scale-110',
          selected ? 'ring-2 ring-ink ring-offset-2 ring-offset-[var(--sg-surface)]' : '',
        )}
        style={{ background: color ?? 'var(--sg-accent)' }}
      />
    </Primitive.Item>
  )
}
