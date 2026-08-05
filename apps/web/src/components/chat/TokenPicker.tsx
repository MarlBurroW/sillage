import { Terminal } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { PickerEntry } from '../../lib/composer-tokens'
import { cx } from '../ui'

/**
 * Liste proposée sous le sigle en cours de saisie, `/` pour les commandes du CLI et
 * `$` pour ses compétences.
 *
 * Posée au-dessus de la zone de saisie pour la même raison que `MentionPicker` : sur
 * téléphone, le clavier virtuel occupe le bas de l'écran.
 */
export function TokenPicker({
  sigil,
  entries,
  active,
  label,
  emptyLabel,
  onPick,
  onHover,
}: {
  sigil: string
  entries: PickerEntry[]
  active: number
  label: string
  emptyLabel: string
  onPick: (entry: PickerEntry) => void
  onHover: (index: number) => void
}) {
  const list = useRef<HTMLUListElement>(null)

  // La navigation au clavier peut sortir de la zone visible : l'élément actif est
  // ramené dans le cadre, sans faire défiler la conversation derrière.
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (entries.length === 0) {
    return (
      <div className="surface mb-1.5 rounded-lg border border-line p-2.5 text-xs text-ink-faint shadow-float">
        {emptyLabel}
      </div>
    )
  }

  return (
    <ul
      ref={list}
      role="listbox"
      aria-label={label}
      className="surface mb-1.5 max-h-56 overflow-y-auto rounded-lg border border-line p-1 shadow-float"
    >
      {entries.map((entry, index) => (
        <li key={entry.name}>
          <button
            type="button"
            role="option"
            aria-selected={index === active}
            // `onMouseDown` : un `onClick` laisserait d'abord le champ perdre le focus,
            // ce qui referme la liste avant que la sélection soit prise en compte.
            onMouseDown={(event) => {
              event.preventDefault()
              onPick(entry)
            }}
            onMouseEnter={() => onHover(index)}
            className={cx(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
              index === active ? 'bg-accent-wash text-ink' : 'text-ink-soft',
            )}
          >
            <Terminal size={13} className="shrink-0 text-ink-faint" />
            <span className="shrink-0 font-mono">
              {sigil}
              {entry.name}
            </span>
            {entry.hint ? (
              <span className="shrink-0 font-mono text-[0.6875rem] text-ink-faint">{entry.hint}</span>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-right text-[0.6875rem] text-ink-faint">
              {entry.summary}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
