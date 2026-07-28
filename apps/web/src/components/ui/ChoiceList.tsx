import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { cx } from './cx'

export interface Choice<T extends string> {
  value: T
  label: string
  hint?: string
  icon?: ReactNode
}

/**
 * Un choix parmi quelques-uns, dépliés plutôt que repliés dans une liste déroulante.
 *
 * Un `select` cache les options derrière un clic : on ne sait pas ce qu'on peut choisir
 * avant d'ouvrir, et on ne voit jamais deux options côte à côte. Quand elles sont peu
 * nombreuses et qu'elles portent une explication, les montrer coûte quelques lignes et
 * évite l'ouverture. Au-delà d'une demi-douzaine, la liste déroulante reprend l'avantage.
 *
 * Sémantique de groupe de boutons radio, pas de boutons pressés : les options
 * s'excluent, et un lecteur d'écran doit l'annoncer comme tel.
 */
export function ChoiceList<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: Choice<T>[]
  onChange: (value: T) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-ink-soft">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex flex-col gap-1.5">
        {options.map((option) => {
          const selected = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option.value)}
              className={cx(
                'flex items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-colors',
                selected
                  ? 'border-accent bg-accent-wash'
                  : 'border-line hover:border-line-strong hover:bg-surface-high',
              )}
            >
              {option.icon ? (
                <span className={cx('shrink-0', selected ? 'text-accent' : 'text-ink-faint')}>
                  {option.icon}
                </span>
              ) : null}
              <span className="min-w-0 flex-1">
                <span className={cx('block truncate text-sm', selected ? 'text-ink' : 'text-ink-soft')}>
                  {option.label}
                </span>
                {option.hint ? (
                  <span className="block truncate text-xs text-ink-faint">{option.hint}</span>
                ) : null}
              </span>
              {/* Place réservée en permanence : la coche apparaissant au choix
                  décalerait le libellé de chaque ligne au moment du clic. */}
              <span className="w-4 shrink-0 text-accent">
                {selected ? <Check size={16} /> : null}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
