import { FileCode } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { FileMatchDto } from '../../lib/files'
import { cx } from '../ui'
import { useTranslate } from '../../lib/i18n'

/**
 * Liste des fichiers proposés pour une mention.
 *
 * Posée au-dessus de la zone de saisie et non en dessous : sur téléphone, le clavier
 * virtuel occupe tout le bas de l'écran et une liste sous le champ serait invisible.
 */
export function MentionPicker({
  files,
  active,
  loading,
  onPick,
  onHover,
}: {
  files: FileMatchDto[]
  active: number
  loading: boolean
  onPick: (file: FileMatchDto) => void
  onHover: (index: number) => void
}) {
  const t = useTranslate()
  const list = useRef<HTMLUListElement>(null)

  // La navigation au clavier peut sortir de la zone visible : l'élément actif est
  // ramené dans le cadre, sans faire défiler la conversation derrière.
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!loading && files.length === 0) {
    return (
      <div className="surface mb-1.5 rounded-lg border border-line p-2.5 text-xs text-ink-faint shadow-float">
        Aucun fichier ne correspond.
      </div>
    )
  }

  return (
    <ul
      ref={list}
      role="listbox"
      aria-label={t('mention.picker.aria')}
      className="surface mb-1.5 max-h-56 overflow-y-auto rounded-lg border border-line p-1 shadow-float"
    >
      {files.map((file, index) => (
        <li key={file.path}>
          <button
            type="button"
            role="option"
            aria-selected={index === active}
            // `onMouseDown` : un `onClick` laisserait d'abord le champ perdre le focus,
            // ce qui referme la liste avant que la sélection soit prise en compte.
            onMouseDown={(event) => {
              event.preventDefault()
              onPick(file)
            }}
            onMouseEnter={() => onHover(index)}
            className={cx(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
              index === active ? 'bg-accent-wash text-ink' : 'text-ink-soft',
            )}
          >
            <FileCode size={13} className="shrink-0 text-ink-faint" />
            <span className="shrink-0">{file.name}</span>
            <span className="min-w-0 flex-1 truncate text-right font-mono text-[0.6875rem] text-ink-faint">
              {file.path}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
