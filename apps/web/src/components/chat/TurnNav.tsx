import { ChevronDown, ChevronUp } from 'lucide-react'
import { cx } from '../ui'

/**
 * Navigation d'un tour à l'autre.
 *
 * La réglette latérale ne s'affiche qu'au-delà d'une certaine largeur et demande de
 * viser un trait de deux pixels : au doigt, elle ne sert à rien. Ces deux flèches
 * couvrent le même besoin partout, et restent utiles au clavier sur grand écran.
 *
 * Le placement appartient à l'appelant : les flèches se posent juste au-dessus de la
 * barre de saisie, dont la hauteur varie, et non au milieu du fil où elles
 * recouvraient les messages.
 */
export function TurnNav({ count, onStep }: { count: number; onStep: (direction: -1 | 1) => void }) {
  // Un seul tour ne se parcourt pas.
  if (count < 2) return null

  return (
    <div
      className={cx(
        'surface flex flex-col overflow-hidden rounded-full border border-line shadow-float',
      )}
    >
      <button
        type="button"
        onClick={() => onStep(-1)}
        aria-label="Tour précédent"
        title="Tour précédent"
        className="flex size-9 items-center justify-center text-ink-faint transition-colors hover:bg-surface-high hover:text-ink"
      >
        <ChevronUp size={16} />
      </button>
      <span aria-hidden className="h-px bg-line" />
      <button
        type="button"
        onClick={() => onStep(1)}
        aria-label="Tour suivant"
        title="Tour suivant"
        className="flex size-9 items-center justify-center text-ink-faint transition-colors hover:bg-surface-high hover:text-ink"
      >
        <ChevronDown size={16} />
      </button>
    </div>
  )
}
