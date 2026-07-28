import { Check, Copy } from 'lucide-react'
import { useCopy } from '../../lib/clipboard'
import { cx } from '../ui'
import { useTranslate } from '../../lib/i18n'

/**
 * Copie d'un bloc de texte.
 *
 * Discret au survol sur desktop, toujours visible au doigt : un bouton qui n'apparaît
 * qu'au survol est inatteignable sur un écran tactile.
 */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useTranslate()
  // Résolu ici et non en valeur par défaut de paramètre : un défaut ne peut pas
  // appeler de hook, et une constante figerait le libellé dans la langue de départ.
  const title = label ?? t('copy.message.aria')
  const { state, copy } = useCopy()

  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      onClick={() => copy(text)}
      className={cx(
        'flex items-center gap-1 rounded-md px-1.5 py-1 text-[0.6875rem] transition-[color,opacity]',
        'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100',
        state === 'failed' ? 'text-critical' : 'text-ink-faint hover:text-ink',
      )}
    >
      {state === 'copied' ? <Check size={13} /> : <Copy size={13} />}
      {state === 'copied' ? t('common.copied') : state === 'failed' ? t('common.failed') : t('common.copy')}
    </button>
  )
}
