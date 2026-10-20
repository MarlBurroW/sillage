import * as Primitive from '@radix-ui/react-context-menu'
import type { ReactNode } from 'react'
import { cx } from './cx'
import { MenuHint } from './Menu'

/**
 * Menu au clic droit.
 *
 * Primitive distincte du menu déroulant plutôt qu'un `Menu` ouvert à la main : le clic
 * droit doit se positionner au curseur, pas sous un déclencheur, et il faut aussi
 * l'appui long au doigt, que Radix gère ici et pas là-bas. L'habillage reste celui des
 * menus de l'application, à un seul endroit près : `Item` et consorts appartiennent à
 * deux modules Radix différents et ne se partagent pas.
 */
export function ContextMenu({
  trigger,
  disabled = false,
  children,
}: {
  trigger: ReactNode
  /**
   * Coupe le déclencheur sans retirer le menu de l'arbre. Sert au doigt, quand l'appui
   * long appartient déjà à un autre geste (le glissement d'une ligne) et qu'un bouton
   * visible donne de toute façon les mêmes actions.
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
          // Un long menu au doigt dépasserait l'écran : il défile plutôt que d'être rogné.
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
  /** Grisée plutôt que retirée, comme `MenuItem`. */
  disabled?: boolean
  /** Raccourci clavier équivalent, voir `MenuHint`. */
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

/** La pastille de couleur de `MenuSwatch`, pour un menu au clic droit. */
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
