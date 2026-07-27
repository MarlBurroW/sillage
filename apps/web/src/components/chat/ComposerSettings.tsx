import * as Dialog from '@radix-ui/react-dialog'
import { SlidersHorizontal, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cx, type SelectTone } from '../ui'

/**
 * Un réglage de la barre du composer, rendu à deux endroits.
 *
 * `render` reçoit la variante plutôt que de figer un `<Select>` : la pastille de la
 * barre et le champ de la feuille sont le même contrôle, et les dupliquer laisserait
 * l'un des deux dériver.
 */
export interface ComposerControl {
  key: string
  render: (variant: 'pill' | 'field') => ReactNode
  /** Valeur en cours, rendue lisible : c'est elle qui s'affiche sur le déclencheur. */
  current: string
}

interface ComposerSettingsProps {
  controls: ComposerControl[]
  /** `caution` quand l'un des réglages repliés retire un garde-fou. */
  tone: SelectTone
}

export function ComposerSettings({ controls, tone }: ComposerSettingsProps) {
  const [open, setOpen] = useState(false)

  // Replier ne doit pas revenir à cacher : le déclencheur porte l'état de tous les
  // réglages, pas seulement du modèle, faute de quoi il faut ouvrir la feuille pour
  // savoir dans quel mode on travaille.
  const summary = controls.map((control) => control.current).join(' · ')

  return (
    <>
      {/* Le seuil est mesuré sur le composer (`@container`) et non sur la fenêtre :
          c'est sa largeur qui décide si les pastilles tiennent, et elle dépend aussi
          de la sidebar. En dessous, quatre pastilles occupaient toute la barre et
          repoussaient les boutons d'envoi hors du champ visible. */}
      <div
        className={cx(
          '-my-1 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1',
          '@max-[34rem]:hidden',
        )}
      >
        {controls.map((control) => (
          <span key={control.key} className="min-w-0">
            {control.render('pill')}
          </span>
        ))}
      </div>

      <div className="min-w-0 flex-1 @min-[34rem]:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          // Le nom du modèle seul ne dit pas qu'on ouvre les réglages.
          aria-label={`Réglages de la conversation, ${summary}`}
          className={cx(
            'flex h-8 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs',
            'transition-colors',
            tone === 'caution'
              ? 'border-caution/50 bg-caution/12 text-caution'
              : 'border-transparent bg-surface-high text-ink',
          )}
        >
          <SlidersHorizontal size={13} className={cx('shrink-0', tone === 'neutral' && 'text-ink-faint')} />
          <span className="min-w-0 truncate">{summary}</span>
        </button>
      </div>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
          {/* Feuille ancrée en bas : c'est la moitié de l'écran atteignable au pouce,
              et elle s'ouvre à côté du composer d'où elle vient. */}
          <Dialog.Content
            className={cx(
              'surface fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col overflow-hidden',
              'rounded-t-xl border-t border-line shadow-pop',
            )}
          >
            <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
              <Dialog.Title className="flex-1 text-sm font-semibold">
                Réglages de la conversation
              </Dialog.Title>
              <Dialog.Close
                aria-label="Fermer"
                className="rounded-md p-1 text-ink-faint transition-colors hover:text-ink"
              >
                <X size={18} />
              </Dialog.Close>
            </header>

            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 pb-safe">
              {controls.map((control) => (
                <div key={control.key}>{control.render('field')}</div>
              ))}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
