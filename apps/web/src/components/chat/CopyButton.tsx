import { Check, Copy } from 'lucide-react'
import { useCopy } from '../../lib/clipboard'
import { cx } from '../ui'

/**
 * Copie d'un bloc de texte.
 *
 * Discret au survol sur desktop, toujours visible au doigt : un bouton qui n'apparaît
 * qu'au survol est inatteignable sur un écran tactile.
 */
export function CopyButton({ text, label = 'Copier le message' }: { text: string; label?: string }) {
  const { state, copy } = useCopy()

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => copy(text)}
      className={cx(
        'flex items-center gap-1 rounded-md px-1.5 py-1 text-[0.6875rem] transition-[color,opacity]',
        'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100',
        state === 'failed' ? 'text-critical' : 'text-ink-faint hover:text-ink',
      )}
    >
      {state === 'copied' ? <Check size={13} /> : <Copy size={13} />}
      {state === 'copied' ? 'Copié' : state === 'failed' ? 'Échec' : 'Copier'}
    </button>
  )
}
