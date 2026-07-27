import { FolderSearch } from 'lucide-react'
import { useId, useState } from 'react'
import { DirectoryPicker } from './DirectoryPicker'
import { cx } from './ui'

interface PathFieldProps {
  label: string
  value: string
  onChange: (path: string) => void
  hint?: string
  error?: string
  placeholder?: string
}

/**
 * Saisie d'un chemin : champ texte pour ceux qui tapent vite, explorateur pour le
 * reste. Les deux écrivent la même valeur, aucun des deux n'est un mode dégradé.
 */
export function PathField({ label, value, onChange, hint, error, placeholder }: PathFieldProps) {
  const id = useId()
  const [pickerOpen, setPickerOpen] = useState(false)
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink-soft">
        {label}
      </label>

      <div className="flex items-stretch gap-2">
        <div
          className={cx(
            'tap-target flex min-w-0 flex-1 items-center rounded-md border bg-sunken px-3',
            'transition-colors focus-within:border-accent',
            error ? 'border-critical' : 'border-line hover:border-line-strong',
          )}
        >
          <input
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-sm text-ink outline-none placeholder:text-ink-faint"
          />
        </div>

        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className={cx(
            'tap-target flex shrink-0 items-center gap-2 rounded-md border border-line px-3',
            'surface text-sm text-ink-soft transition-colors',
            'hover:border-line-strong hover:text-ink',
          )}
        >
          <FolderSearch size={16} />
          <span className="hidden sm:inline">Parcourir</span>
        </button>
      </div>

      {error ? (
        <p id={`${id}-error`} className="text-xs text-critical">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-ink-faint">
          {hint}
        </p>
      ) : null}

      <DirectoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={value}
        onConfirm={onChange}
      />
    </div>
  )
}
