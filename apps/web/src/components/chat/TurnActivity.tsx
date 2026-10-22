import { useTypingIndicator } from '../../lib/typing-indicator'
import { TypingIndicator } from './TypingIndicator'

/**
 * Activity at thread bottom throughout turns. Previously tied to reasoning blocks, indicators
 * vanished when messages ended even mid-turn before more tools. Here only running-turn state
 * controls visibility.
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
