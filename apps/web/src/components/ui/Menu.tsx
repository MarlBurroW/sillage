import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { ReactNode } from 'react'
import { cx } from './cx'

interface MenuProps {
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'end'
}

export function Menu({ trigger, children, align = 'end' }: MenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={4}
          className={cx(
            'z-50 min-w-44 overflow-hidden rounded-lg border border-line p-1',
            'surface shadow-pop',
          )}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

interface MenuItemProps {
  icon?: ReactNode
  onSelect: () => void
  tone?: 'neutral' | 'critical'
  /**
   * Une action momentanément impossible reste affichée plutôt que retirée : la voir
   * grisée dit qu'elle existe et qu'elle reviendra, alors que sa disparition laisse
   * croire qu'elle n'existe pas.
   */
  disabled?: boolean
  children: ReactNode
}

export function MenuItem({
  icon,
  onSelect,
  tone = 'neutral',
  disabled = false,
  children,
}: MenuItemProps) {
  return (
    <DropdownMenu.Item
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
    </DropdownMenu.Item>
  )
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-line" />
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pt-1.5 pb-1 text-[0.6875rem] font-semibold tracking-wide text-ink-faint uppercase">
      {children}
    </p>
  )
}

/**
 * Pastille de couleur. `DropdownMenu.Item` en `asChild` pour que Radix ferme le menu
 * et gère le focus, tout en gardant un bouton rond plutôt qu'une ligne de menu.
 */
export function MenuSwatch({
  color,
  selected,
  label,
  onSelect,
}: {
  /** null signifie « couleur d'accent du thème ». */
  color: string | null
  selected: boolean
  label: string
  onSelect: () => void
}) {
  return (
    <DropdownMenu.Item asChild onSelect={onSelect}>
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
    </DropdownMenu.Item>
  )
}

export function MenuSwatchRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-1 pb-2">{children}</div>
}
