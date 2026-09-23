import { Lightbulb, X } from 'lucide-react'
import { useState } from 'react'
import { prefillComposer } from '../../lib/composer-ref'
import { useTranslate } from '../../lib/i18n'
import { IconButton } from '../ui'

/**
 * Le message suivant que le CLI prédit, proposé sous le fil, au-dessus de la saisie.
 *
 * Un tap le pose dans la barre de saisie sans l'envoyer : la suggestion vaut un
 * brouillon, pas une décision. Elle disparaît d'elle-même dès qu'un tour repart,
 * puisque l'état qui la porte est remis à zéro par le fold ; ignorer ne fait que la
 * cacher plus tôt, et seulement celle-là, la suivante reviendra.
 */
export function PromptSuggestion({ text, disabled }: { text: string; disabled: boolean }) {
  const t = useTranslate()
  const [dismissed, setDismissed] = useState<string | null>(null)

  if (dismissed === text) return null

  return (
    <div className="flex items-start gap-2 rounded-lg border border-dashed border-line bg-surface/40 px-3 py-2">
      <Lightbulb size={14} className="mt-1 shrink-0 text-accent" />
      <button
        type="button"
        disabled={disabled}
        onClick={() => prefillComposer(text)}
        title={t('suggestion.use')}
        className="min-w-0 flex-1 text-left text-sm text-ink-soft hover:text-ink disabled:pointer-events-none disabled:opacity-60"
      >
        <span className="block text-[0.6875rem] text-ink-faint">{t('suggestion.label')}</span>
        <span className="line-clamp-3 whitespace-pre-wrap break-words">{text}</span>
      </button>
      <IconButton label={t('suggestion.dismiss')} onClick={() => setDismissed(text)}>
        <X size={14} />
      </IconButton>
    </div>
  )
}
