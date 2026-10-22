import { useSyncExternalStore } from 'react'
import type { WorkspaceScope } from './workspace-scope'

/**
 * Explorer state retained between displays: expanded directories, selection, and copied or cut
 * entries. Stored outside React per scope: the column unmounts when closed and search temporarily
 * replaces the tree. Row-local state used to disappear each time, requiring the whole path to be
 * expanded again. Each row subscribes only to its own expanded, selected, and cut state so
 * selecting an entry does not redraw thousands of others.
 */
export interface TreeView {
  expanded: ReadonlySet<string>
  /** Selected path to directory flag. Type is needed for bulk actions. */
  selection: ReadonlyMap<string, boolean>
  /** Shift-selection anchor: the last plain click. */
  anchor: string | null
  /** Touch selection mode: without Ctrl, this makes a tap select an entry instead of opening it. */
  selecting: boolean
  /** Copied or cut entries with their types, like selection. */
  clipboard: { mode: 'copy' | 'cut'; entries: ReadonlyMap<string, boolean> } | null
}

const EMPTY: TreeView = {
  expanded: new Set(),
  selection: new Map(),
  anchor: null,
  selecting: false,
  clipboard: null,
}

const views = new Map<WorkspaceScope, TreeView>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getTreeView(scope: WorkspaceScope): TreeView {
  return views.get(scope) ?? EMPTY
}

function update(scope: WorkspaceScope, change: (view: TreeView) => Partial<TreeView>): void {
  const current = getTreeView(scope)
  const next = { ...current, ...change(current) }
  // Clearing selection exits selection mode, or the next tap would still select without a visible explanation.
  if (next.selection.size === 0) next.selecting = false
  views.set(scope, next)
  for (const notify of listeners) notify()
}

/** Selector returning a primitive value: the row redraws only when it changes. */
export function useTreeView<T extends string | number | boolean | null>(
  scope: WorkspaceScope,
  select: (view: TreeView) => T,
): T {
  return useSyncExternalStore(
    subscribe,
    () => select(getTreeView(scope)),
    () => select(EMPTY),
  )
}

/** Whether `path` equals `ancestor` or is one of its descendants. */
export function isWithin(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`)
}

// Expanded directories

export function setExpanded(scope: WorkspaceScope, path: string, open: boolean): void {
  update(scope, (view) => {
    const expanded = new Set(view.expanded)
    if (open) {
      expanded.add(path)
      return { expanded }
    }
    expanded.delete(path)
    // Remove collapsed entries from selection: a selected but hidden entry could otherwise be
    // silently included in the next deletion.
    const selection = new Map(
      [...view.selection].filter(([selected]) => !selected.startsWith(`${path}/`)),
    )
    return { expanded, selection }
  })
}

/** Expand all directories leading to `path` so it becomes visible. */
export function revealPath(scope: WorkspaceScope, path: string): void {
  const parts = path.split('/')
  const ancestors = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
  if (ancestors.every((ancestor) => getTreeView(scope).expanded.has(ancestor))) return
  update(scope, (view) => ({ expanded: new Set([...view.expanded, ...ancestors]) }))
}

export function collapseAll(scope: WorkspaceScope): void {
  update(scope, (view) => ({
    expanded: new Set(),
    // Keep only still-visible root entries selected.
    selection: new Map([...view.selection].filter(([path]) => !path.includes('/'))),
  }))
}

// Selection

export function selectOnly(scope: WorkspaceScope, path: string, isDirectory: boolean): void {
  update(scope, () => ({ selection: new Map([[path, isDirectory]]), anchor: path }))
}

export function toggleSelected(scope: WorkspaceScope, path: string, isDirectory: boolean): void {
  update(scope, (view) => {
    const selection = new Map(view.selection)
    if (selection.has(path)) selection.delete(path)
    else selection.set(path, isDirectory)
    return { selection, anchor: path }
  })
}

/**
 * Replace selection with `entries` or add them. Update the anchor only when provided: repeated
 * Shift-clicks start at the same point, like any explorer.
 */
export function selectMany(
  scope: WorkspaceScope,
  entries: ReadonlyArray<readonly [string, boolean]>,
  { additive = false, anchor }: { additive?: boolean; anchor?: string } = {},
): void {
  update(scope, (view) => ({
    selection: new Map([...(additive ? view.selection : []), ...entries]),
    anchor: anchor ?? view.anchor,
  }))
}

export function clearSelection(scope: WorkspaceScope): void {
  update(scope, () => ({ selection: new Map(), anchor: null, selecting: false }))
}

/**
 * Enter selection mode with this entry selected. Outside the mode, start with this entry alone: a
 * directory touched to open it was not chosen for selection.
 */
export function startSelecting(scope: WorkspaceScope, path: string, isDirectory: boolean): void {
  update(scope, (view) => ({
    selection: new Map([...(view.selecting ? view.selection : []), [path, isDirectory]]),
    anchor: path,
    selecting: true,
  }))
}

// Clipboard

export function setTreeClipboard(
  scope: WorkspaceScope,
  mode: 'copy' | 'cut',
  entries: ReadonlyArray<readonly [string, boolean]>,
): void {
  update(scope, () => ({ clipboard: entries.length > 0 ? { mode, entries: new Map(entries) } : null }))
}

export function clearTreeClipboard(scope: WorkspaceScope): void {
  update(scope, () => ({ clipboard: null }))
}

// Tracking file operations

/**
 * Apply a rename or move: expanded directories and selected entries retain their state under the
 * new name.
 */
export function renameInView(scope: WorkspaceScope, from: string, to: string): void {
  const move = (path: string) => (isWithin(path, from) ? to + path.slice(from.length) : path)
  update(scope, (view) => ({
    expanded: new Set([...view.expanded].map(move)),
    selection: new Map([...view.selection].map(([path, isDirectory]) => [move(path), isDirectory])),
    anchor: view.anchor === null ? null : move(view.anchor),
    clipboard: view.clipboard && {
      ...view.clipboard,
      entries: new Map([...view.clipboard.entries].map(([path, isDirectory]) => [move(path), isDirectory])),
    },
  }))
}

/** Forget deleted entries and everything they contained. */
export function forgetInView(scope: WorkspaceScope, removed: string[]): void {
  const gone = (path: string) => removed.some((entry) => isWithin(path, entry))
  update(scope, (view) => ({
    expanded: new Set([...view.expanded].filter((path) => !gone(path))),
    selection: new Map([...view.selection].filter(([path]) => !gone(path))),
    anchor: view.anchor !== null && gone(view.anchor) ? null : view.anchor,
    clipboard: view.clipboard && {
      ...view.clipboard,
      entries: new Map([...view.clipboard.entries].filter(([path]) => !gone(path))),
    },
  }))
}

/**
 * Remove entries already included within a listed directory: moving a directory and one of its
 * files would otherwise move that file twice, with the second attempt failing.
 */
export function topLevelPaths(paths: Iterable<string>): string[] {
  const unique = [...new Set(paths)]
  return unique.filter(
    (path) => !unique.some((other) => other !== path && path.startsWith(`${other}/`)),
  )
}
