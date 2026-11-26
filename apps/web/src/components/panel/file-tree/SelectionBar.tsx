import { Copy, Download, Scissors, Trash2, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { downloadArchive, downloadFile } from '../../../lib/files-io'
import { useTranslate } from '../../../lib/i18n'
import { clearSelection, getTreeView, useTreeView } from '../../../lib/tree-view'
import { cx } from '../../ui'
import { TooltipButton } from '../../ui/Tooltip'
import type { Actions } from './shared'

/**
 * Bulk action bar when multiple entries are selected. Context menus also offer these actions but
 * are undiscoverable, and touch selection mode prevents long-press menus, making this the only
 * touch route.
 */
export function SelectionBar({ actions }: { actions: Actions }) {
  const t = useTranslate()
  const { scope } = actions
  const count = useTreeView(scope, (view) => view.selection.size)
  const selecting = useTreeView(scope, (view) => view.selecting)
  if (count < 2 && !selecting) return null

  const targets = () => [...getTreeView(scope).selection]

  return (
    <div
      role="toolbar"
      aria-label={t('filetree.selection.aria')}
      className="mx-2 mb-1.5 flex items-center gap-px rounded-md border border-accent/40 bg-accent-wash pr-0.5 pl-2"
    >
      <span className="min-w-0 flex-1 truncate text-xs font-medium whitespace-nowrap text-ink">
        {t(count > 1 ? 'filetree.selection.count.other' : 'filetree.selection.count.one', { count })}
      </span>
      <RootAction
        compact
        label={t('filetree.entry.cut')}
        icon={<Scissors size={13} />}
        onClick={() => actions.onClipboard('cut', targets())}
      />
      <RootAction
        compact
        label={t('filetree.entry.copy')}
        icon={<Copy size={13} />}
        onClick={() => actions.onClipboard('copy', targets())}
      />
      <RootAction
        compact
        label={t('filetree.entry.downloadZip')}
        icon={<Download size={13} />}
        onClick={() => {
          const picked = targets()
          // Download single files directly; wrapping adds nothing.
          const [only] = picked
          if (picked.length === 1 && only && !only[1]) downloadFile(scope, only[0])
          else downloadArchive(scope, picked.map(([path]) => path))
        }}
      />
      <RootAction
        compact
        label={t('filetree.selection.delete', { count })}
        icon={<Trash2 size={13} />}
        onClick={() => actions.onDelete(targets())}
      />
      <RootAction
        compact
        label={t('filetree.selection.clear')}
        icon={<X size={13} />}
        onClick={() => clearSelection(scope)}
      />
    </div>
  )
}

/** Icon button of the explorer header and of the selection bar. */
export function RootAction({
  label,
  icon,
  onClick,
  compact = false,
}: {
  label: string
  icon: ReactNode
  onClick: () => void
  /** Tighter mouse layout: the selection bar also contains the count. */
  compact?: boolean
}) {
  return (
    <TooltipButton
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cx(
        'flex size-11 shrink-0 pointer-coarse:size-11 items-center justify-center rounded',
        'text-ink-faint transition-colors hover:bg-surface-high hover:text-ink',
        compact ? 'md:size-6' : 'md:size-7',
      )}
    >
      {icon}
    </TooltipButton>
  )
}
