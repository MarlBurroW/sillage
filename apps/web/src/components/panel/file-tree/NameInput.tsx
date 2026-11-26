import { useState } from 'react'
import { useTranslate } from '../../../lib/i18n'
import { INDENT_PX } from './shared'

/**
 * Name input for creation and rename. Select the basename without extension because renaming
 * usually changes the stem and retyping .tsx adds no value.
 */
export function NameInput({
  depth,
  icon,
  initial,
  onCommit,
  onCancel,
}: {
  depth: number
  icon: string
  initial: string
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const t = useTranslate()
  const [value, setValue] = useState(initial)

  return (
    <div
      className="flex h-7 items-center gap-1.5 pr-2"
      style={{ paddingLeft: depth * INDENT_PX + 6 }}
    >
      <span className="w-3 shrink-0" />
      <img src={icon} alt="" aria-hidden className="size-4 shrink-0" />
      <input
        autoFocus
        aria-label={t('filetree.name.label')}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onFocus={(event) => {
          const dot = initial.lastIndexOf('.')
          event.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length)
        }}
        // The text field's own menu (paste…), not the tree's.
        onContextMenu={(event) => event.stopPropagation()}
        onBlur={() => {
          const name = value.trim()
          if (name && name !== initial) onCommit(name)
          else onCancel()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            const name = value.trim()
            if (name) onCommit(name)
            else onCancel()
          }
          if (event.key === 'Escape') onCancel()
        }}
        className="h-6 min-w-0 flex-1 rounded border border-accent bg-sunken px-1 text-[0.8125rem] text-ink outline-none"
      />
    </div>
  )
}
