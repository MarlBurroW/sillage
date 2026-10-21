import { useTypingIndicator } from '../../lib/typing-indicator'
import { TypingIndicator } from './TypingIndicator'

/**
 * Indicateur d'activité en bas du fil, présent du début à la fin du tour.
 *
 * L'ancien repère vivait dans le bloc de réflexion, donc il s'effaçait dès qu'un
 * message se terminait, y compris au milieu d'un tour qui enchaînait ensuite des
 * outils. Ici, la seule condition d'affichage est « un tour est en cours ».
 */
export function TurnActivity({ label }: { label: string }) {
  const [variant] = useTypingIndicator()
  return (
    <div className="flex items-center gap-2 py-1 text-xs text-ink-faint" aria-live="polite">
      <TypingIndicator variant={variant} />
      <span className="font-medium">{label}</span>
    </div>
  )
}
