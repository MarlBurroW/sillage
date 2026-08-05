import { Terminal } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { commandSummary, type CommandMatch } from '../../lib/commands'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

/**
 * Liste des commandes proposées après un `/`.
 *
 * Posée au-dessus de la zone de saisie pour la même raison que `MentionPicker` : sur
 * téléphone, le clavier virtuel occupe le bas de l'écran.
 */
export function CommandPicker({
  matches,
  active,
  onPick,
  onHover,
}: {
  matches: CommandMatch[]
  active: number
  onPick: (match: CommandMatch) => void
  onHover: (index: number) => void
}) {
  const t = useTranslate()
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (matches.length === 0) {
    return (
      <div className="surface mb-1.5 rounded-lg border border-line p-2.5 text-xs text-ink-faint shadow-float">
        {t('command.picker.empty')}
      </div>
    )
  }

  return (
    <ul
      ref={list}
      role="listbox"
      aria-label={t('command.picker.aria')}
      className="surface mb-1.5 max-h-56 overflow-y-auto rounded-lg border border-line p-1 shadow-float"
    >
      {matches.map(({ command, name }, index) => (
        <li key={name}>
          <button
            type="button"
            role="option"
            aria-selected={index === active}
            // `onMouseDown` : un `onClick` laisserait d'abord le champ perdre le focus,
            // ce qui referme la liste avant que la sélection soit prise en compte.
            onMouseDown={(event) => {
              event.preventDefault()
              onPick({ command, name })
            }}
            onMouseEnter={() => onHover(index)}
            className={cx(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
              index === active ? 'bg-accent-wash text-ink' : 'text-ink-soft',
            )}
          >
            <Terminal size={13} className="shrink-0 text-ink-faint" />
            <span className="shrink-0 font-mono">/{name}</span>
            {command.argumentHint ? (
              <span className="shrink-0 font-mono text-[0.6875rem] text-ink-faint">
                {command.argumentHint}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-right text-[0.6875rem] text-ink-faint">
              {commandSummary(command)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
