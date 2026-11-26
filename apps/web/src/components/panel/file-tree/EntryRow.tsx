import { memo, type ReactNode } from 'react'
import type { TreeEntryDto } from '@sillage/protocol'
import { useIsActiveTab } from '../../../lib/editor-tabs'
import { fileIconUrl } from '../../../lib/file-icons'
import { useTreeView } from '../../../lib/tree-view'
import { cx } from '../../ui'
import { selectFromClick } from './rows-dom'
import type { Actions } from './shared'

/** Row background precedence: selection, open file, then hover. */
export function rowTone(selected: boolean, active: boolean): string {
  if (selected) return 'bg-accent-wash text-ink'
  if (active) return 'bg-accent-wash/45'
  return 'hover:bg-surface-high'
}

/** Search-result row: no chevron, drag-and-drop, or indentation because it represents no tree level. */
export const EntryRow = memo(function EntryRow({
  entry,
  actions,
  children,
}: {
  entry: TreeEntryDto
  actions: Actions
  children: ReactNode
}) {
  const selected = useTreeView(actions.scope, (view) => view.selection.has(entry.path))
  const active = useIsActiveTab(actions.scope, entry.path)

  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={selected}
      aria-current={active ? true : undefined}
      data-tree-path={entry.path}
      data-tree-name={entry.name}
      onMouseDown={(event) => {
        // Shift-click extends selection; prevent browser text selection too.
        if (event.shiftKey) event.preventDefault()
      }}
      onClick={(event) => {
        if (!selectFromClick(event, entry, actions)) actions.open(entry.path, true)
      }}
      onDoubleClick={(event) => {
        if (event.shiftKey || event.metaKey || event.ctrlKey) return
        actions.open(entry.path)
      }}
      className={cx(
        'flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left select-none',
        // Inset the global focus ring or the column would clip it.
        'transition-colors focus-visible:-outline-offset-2',
        rowTone(selected, active),
      )}
    >
      <img src={fileIconUrl(entry.name, false)} alt="" aria-hidden className="size-4 shrink-0" />
      {children}
    </button>
  )
})
