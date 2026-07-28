import * as Primitive from '@radix-ui/react-context-menu'
import type { ReactNode } from 'react'
import { cx } from './cx'

/**
 * Menu au clic droit.
 *
 * Primitive distincte du menu déroulant plutôt qu'un `Menu` ouvert à la main : le clic
 * droit doit se positionner au curseur, pas sous un déclencheur, et il faut aussi
 * l'appui long au doigt, que Radix gère ici et pas là-bas. L'habillage reste celui des
 * menus de l'application, à un seul endroit près : `Item` et consorts appartiennent à
 * deux modules Radix différents et ne se partagent pas.
 */
export function ContextMenu({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  return (
    <Primitive.Root>
      <Primitive.Trigger asChild>{trigger}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          className={cx(
            'z-50 min-w-48 overflow-hidden rounded-lg border border-line p-1',
            'surface shadow-pop',
          )}
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
  children,
}: {
  icon?: ReactNode
  onSelect: () => void
  tone?: 'neutral' | 'critical'
  children: ReactNode
}) {
  return (
    <Primitive.Item
      onSelect={onSelect}
      className={cx(
        'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none',
        tone === 'critical'
          ? 'text-critical data-[highlighted]:bg-critical/12'
          : 'text-ink-soft data-[highlighted]:bg-accent-wash data-[highlighted]:text-ink',
      )}
    >
      {icon ? <span className="shrink-0">{icon}</span> : null}
      {children}
    </Primitive.Item>
  )
}

export function ContextMenuSeparator() {
  return <Primitive.Separator className="my-1 h-px bg-line" />
}
