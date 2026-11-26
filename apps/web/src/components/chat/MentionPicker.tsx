import { ChevronRight, FileCode, Folder } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { mentionPath, type FileMatchDto } from '../../lib/files'
import { cx } from '../ui'
import { TooltipButton } from '../ui/Tooltip'
import { useTranslate } from '../../lib/i18n'

/** Mention suggestions above the input because phone keyboards would hide lists beneath it. */
export function MentionPicker({
  files,
  active,
  loading,
  failed,
  onPick,
  onOpen,
  onHover,
}: {
  files: FileMatchDto[]
  active: number
  loading: boolean
  /** The listing request failed: say so rather than claim nothing matches. */
  failed: boolean
  onPick: (file: FileMatchDto) => void
  /** Lists what a folder holds instead of mentioning it: Tab does the same from the keyboard. */
  onOpen: (file: FileMatchDto) => void
  onHover: (index: number) => void
}) {
  const t = useTranslate()
  const list = useRef<HTMLUListElement>(null)

  // Reveal active keyboard entries inside this list without scrolling conversations behind.
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!loading && files.length === 0) {
    return (
      <div className="surface mb-1.5 rounded-lg border border-line p-2.5 text-xs text-ink-faint shadow-float">
        {t(failed ? 'mention.picker.error' : 'mention.picker.empty')}
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
      {files.map((file, index) => {
        const Icon = file.isDirectory ? Folder : FileCode
        return (
          <li
            key={mentionPath(file)}
            className={cx('flex items-center rounded-md', index === active ? 'bg-accent-wash text-ink' : 'text-ink-soft')}
          >
            <button
              type="button"
              role="option"
              aria-selected={index === active}
              // Use mousedown: click blurs input and closes suggestions before selection.
              onMouseDown={(event) => {
                event.preventDefault()
                onPick(file)
              }}
              onMouseEnter={() => onHover(index)}
              className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
            >
              <Icon size={13} className="shrink-0 text-ink-faint" />
              <span className="shrink-0">{file.isDirectory ? `${file.name}/` : file.name}</span>
              <span className="min-w-0 flex-1 truncate text-right font-mono text-[0.6875rem] text-ink-faint">
                {mentionPath(file)}
              </span>
            </button>
            {file.isDirectory ? (
              <TooltipButton
                type="button"
                tabIndex={-1}
                aria-label={t('mention.picker.open')}
                onMouseDown={(event) => {
                  event.preventDefault()
                  onOpen(file)
                }}
                onMouseEnter={() => onHover(index)}
                className="mr-0.5 grid size-7 shrink-0 place-items-center rounded text-ink-faint hover:text-ink"
              >
                <ChevronRight size={14} />
              </TooltipButton>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
