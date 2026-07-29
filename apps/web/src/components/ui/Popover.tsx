import * as RadixPopover from '@radix-ui/react-popover'
import type { ReactNode } from 'react'
import { cx } from './cx'

interface PopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactNode
  children: ReactNode
  /** Nom du panneau : il n'a pas de titre visible permanent. */
  label: string
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
  onEscapeKeyDown?: (event: KeyboardEvent) => void
  /** Radix ramène le focus au déclencheur : à intercepter pour l'envoyer ailleurs. */
  onCloseAutoFocus?: (event: Event) => void
  className?: string
}

/**
 * Panneau ancré à contenu libre.
 *
 * Distinct de `Menu` : celui-ci porte `role="menu"`, dont la navigation clavier est un
 * roving tabindex réservé aux `menuitem`. Un bouton ordinaire posé dedans n'entre ni
 * dans ce parcours ni dans celui de `Tab`, que Radix traite comme une fermeture, et
 * devient cliquable à la souris seulement. Un panneau qui se navigue a donc besoin
 * d'une coque sans sémantique de menu.
 */
export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  label,
  side = 'top',
  align = 'start',
  onEscapeKeyDown,
  onCloseAutoFocus,
  className,
}: PopoverProps) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={12}
          aria-label={label}
          onEscapeKeyDown={onEscapeKeyDown}
          onCloseAutoFocus={onCloseAutoFocus}
          className={cx(
            'z-50 flex flex-col overflow-hidden outline-none',
            'surface rounded-xl border border-line shadow-pop',
            className,
          )}
          // Hauteur bornée par la place réelle au-dessus du déclencheur, que Radix
          // mesure : une constante déborderait sur une fenêtre courte.
          style={{ maxHeight: 'var(--radix-popover-content-available-height)' }}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  )
}
