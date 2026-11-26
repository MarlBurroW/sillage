import type { MouseEvent } from 'react'
import type { TreeEntryDto } from '@sillage/protocol'
import { getTreeView, selectMany, selectOnly, toggleSelected } from '../../../lib/tree-view'
import type { Actions, Picked } from './shared'

/*
 * Rows describe themselves through data attributes (path, name, directory flag, unreachable link):
 * keyboard navigation, range selection and the shared menu read them back here rather than going
 * through row components.
 */

/** Displayed row as a path/type pair read from attributes. */
export function pickedOf(row: HTMLElement): Picked {
  return [row.dataset.treePath ?? '', row.dataset.treeDir === '1']
}

/**
 * Select from the anchor through to in screen order. Without a visible anchor use the targeted row
 * as the start.
 */
export function selectRange(actions: Actions, to: string, additive: boolean): void {
  const rows = actions.rows().map(pickedOf)
  const anchor = getTreeView(actions.scope).anchor
  const from = rows.findIndex(([path]) => path === anchor)
  const until = rows.findIndex(([path]) => path === to)
  const target = rows[until]
  if (!target) return
  if (from === -1) {
    selectOnly(actions.scope, ...target)
    return
  }
  const [low, high] = from < until ? [from, until] : [until, from]
  selectMany(actions.scope, rows.slice(low, high + 1), { additive })
}

/**
 * Desktop-style click selection: Ctrl (Command on Mac) toggles and Shift extends from the previous
 * click. In touch selection mode a tap toggles without modifiers. Return true when selection
 * consumes the click without opening or expanding.
 */
export function selectFromClick(event: MouseEvent, entry: TreeEntryDto, actions: Actions): boolean {
  const { scope } = actions
  const additive = event.metaKey || event.ctrlKey
  // Safari does not focus clicked buttons: explicitly focus or arrows start from the previous row or nowhere.
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus({ preventScroll: true })
  if (event.shiftKey) {
    selectRange(actions, entry.path, additive)
    return true
  }
  if (additive || getTreeView(scope).selecting) {
    toggleSelected(scope, entry.path, entry.isDirectory)
    return true
  }
  selectOnly(scope, entry.path, entry.isDirectory)
  return false
}

/** Entry of the row holding `target`, read from its attributes: the shared menu has no row component. */
export function entryAt(target: EventTarget): TreeEntryDto | null {
  if (!(target instanceof Element)) return null
  const item =
    target.closest('[data-tree-entry]')?.querySelector<HTMLElement>('[data-tree-path]') ??
    target.closest<HTMLElement>('[data-tree-path]')
  if (!item) return null
  return {
    name: item.dataset.treeName ?? '',
    path: item.dataset.treePath ?? '',
    isDirectory: item.dataset.treeDir === '1',
    ...(item.dataset.treeUnreachable ? { symlink: 'outside' as const } : {}),
  }
}

/** Opens the tree's menu below a row's … button, as a right-click there would. */
export function openMenuAt(button: HTMLElement): void {
  const box = button.getBoundingClientRect()
  button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left, clientY: box.bottom }))
}
