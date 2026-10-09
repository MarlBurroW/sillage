import { TooltipButton } from './Tooltip'
import { cx } from './cx'

/**
 * Interrupteur à deux états, pour un réglage qui s'applique au clic.
 *
 * Un bouton « Désactiver » dit ce qu'on va faire ; l'interrupteur montre en plus où on
 * en est, et dans une liste les états se comparent d'une ligne à l'autre d'un coup
 * d'œil. Réservé à ce qui s'applique immédiatement : dans un formulaire à enregistrer,
 * une case à cocher convient mieux.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Obligatoire : l'interrupteur n'a pas de texte, le lecteur d'écran a besoin du sien. */
  label: string
  disabled?: boolean
}) {
  return (
    <TooltipButton
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cx(
        // Même cible tactile que `IconButton` : 44px au doigt, plus serré à la souris.
        'flex size-11 shrink-0 items-center justify-center rounded-md md:h-7 md:w-9 pointer-coarse:size-11',
        'focus-visible:outline-2 focus-visible:outline-accent',
        'disabled:pointer-events-none disabled:opacity-45',
      )}
    >
      <span
        aria-hidden
        className={cx(
          'flex h-5 w-8 items-center rounded-full p-0.5 transition-colors',
          checked ? 'justify-end bg-accent' : 'bg-line-strong',
        )}
      >
        <span className="size-4 rounded-full bg-surface shadow-sm" />
      </span>
    </TooltipButton>
  )
}
