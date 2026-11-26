import type { KeyboardEvent } from 'react'
import { parentOf } from '../../../lib/entries'
import {
  clearSelection,
  clearTreeClipboard,
  getTreeView,
  selectMany,
  selectOnly,
  setExpanded,
  toggleSelected,
} from '../../../lib/tree-view'
import { pickedOf, selectRange } from './rows-dom'
import { nameOf, targetsOf, type Actions } from './shared'

/**
 * Desktop-style explorer shortcuts. Listen on the list rather than individual rows: the event
 * target gives the starting row and DOM order already reflects expanded directories and search
 * results. Reconstructing order from level caches would duplicate rendering work.
 */
export function handleTreeKey(
  event: KeyboardEvent,
  actions: Actions,
  typeahead: { text: string; at: number },
): void {
  const row = (event.target as HTMLElement).closest<HTMLElement>('[data-tree-path]')
  // Rename inputs live in the list and own their keystrokes.
  if (!row || event.target instanceof HTMLInputElement) return

  const { scope } = actions
  const rows = actions.rows()
  const index = rows.indexOf(row)
  const [path, isDirectory] = pickedOf(row)
  const view = getTreeView(scope)
  const mod = event.metaKey || event.ctrlKey
  const targets = targetsOf(view, path, isDirectory)

  /** Move focus; selection follows, extends with Shift, or stays unchanged with Ctrl. */
  const moveTo = (to: number) => {
    const next = rows[Math.max(0, Math.min(rows.length - 1, to))]
    if (!next) return
    next.focus()
    const [nextPath, nextIsDirectory] = pickedOf(next)
    if (event.shiftKey) selectRange(actions, nextPath, false)
    else if (!mod) selectOnly(scope, nextPath, nextIsDirectory)
  }

  switch (event.key) {
    case 'ArrowDown':
      moveTo(index + 1)
      break
    case 'ArrowUp':
      moveTo(index - 1)
      break
    case 'Home':
      moveTo(0)
      break
    case 'End':
      moveTo(rows.length - 1)
      break
    case 'ArrowRight':
      // Expand, then enter the expanded directory.
      if (!isDirectory) return
      if (!view.expanded.has(path)) setExpanded(scope, path, true)
      else if (rows[index + 1]?.dataset.treePath?.startsWith(`${path}/`)) moveTo(index + 1)
      break
    case 'ArrowLeft': {
      // Collapse, then move to the parent directory.
      if (isDirectory && view.expanded.has(path)) {
        setExpanded(scope, path, false)
        break
      }
      const parent = rows.findIndex((candidate) => candidate.dataset.treePath === parentOf(path))
      if (parent === -1) return
      moveTo(parent)
      break
    }
    case 'Enter':
      // Without preventDefault below, buttons also receive a click, previewing what Enter opens permanently.
      if (row.dataset.treeUnreachable) break
      if (isDirectory) setExpanded(scope, path, !view.expanded.has(path))
      else actions.open(path)
      break
    case ' ':
      toggleSelected(scope, path, isDirectory)
      break
    case 'F2':
      actions.setDraft({ mode: 'rename', path, name: row.dataset.treeName ?? nameOf(path) })
      break
    case 'Delete':
      actions.onDelete(targets)
      break
    case 'Backspace':
      // Command-Backspace on Mac keyboards often lacking Delete.
      if (!event.metaKey) return
      actions.onDelete(targets)
      break
    case 'Escape': {
      const cut = view.clipboard?.mode === 'cut'
      if (!cut && view.selection.size === 0) return
      if (cut) clearTreeClipboard(scope)
      clearSelection(scope)
      break
    }
    default: {
      if (mod && !event.altKey) {
        const key = event.key.toLowerCase()
        if (key === 'a') selectMany(scope, rows.map(pickedOf))
        else if (key === 'c') actions.onClipboard('copy', targets)
        else if (key === 'x') actions.onClipboard('cut', targets)
        else if (key === 'v') actions.onPaste(isDirectory ? path : parentOf(path))
        else return
        break
      }

      // Type a name prefix to navigate like any explorer. Nearby keystrokes accumulate; repeating
      // one letter cycles matches.
      if (event.key.length !== 1 || event.altKey) return
      const now = Date.now()
      const text = now - typeahead.at < 700 ? typeahead.text + event.key.toLowerCase() : event.key.toLowerCase()
      typeahead.text = text
      typeahead.at = now
      const start = text.length === 1 ? index + 1 : index
      for (let offset = 0; offset < rows.length; offset += 1) {
        const at = (start + offset) % rows.length
        if (rows[at]?.dataset.treeName?.toLowerCase().startsWith(text)) {
          moveTo(at)
          break
        }
      }
    }
  }
  event.preventDefault()
}
