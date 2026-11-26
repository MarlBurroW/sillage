import { parentOf } from '../../../lib/entries'
import type { TreeDraft, TreeView } from '../../../lib/tree-view'

/** Indent per level, tighter than the sidebar because file trees nest deeper. */
export const INDENT_PX = 12

/** Shortcuts follow the operating system: Command and Option on Mac, Ctrl elsewhere. */
export const IS_MAC = navigator.userAgent.includes('Mac')

/** Targeted entry path and directory flag. */
export type Picked = readonly [path: string, isDirectory: boolean]

export function nameOf(path: string): string {
  return path.split('/').pop() ?? path
}

/**
 * Row actions affect the whole selection if the row belongs to it, otherwise just that row. Desktop
 * explorer convention allows acting without losing selections elsewhere.
 */
export function targetsOf(view: TreeView, path: string, isDirectory: boolean): Picked[] {
  return view.selection.has(path) ? [...view.selection] : [[path, isDirectory]]
}

/**
 * Header buttons create within the last targeted directory, or the parent of a targeted file, like
 * desktop editors; otherwise root.
 */
export function targetFolderOf(view: TreeView): string {
  const anchor = view.anchor
  if (anchor === null || !view.selection.has(anchor)) return ''
  return view.selection.get(anchor) ? anchor : parentOf(anchor)
}

/**
 * Actions available to rows. Pass one object instead of a dozen props through every recursive
 * level, which does not consume them. Selection stays outside: each row reads its own tree-view
 * state.
 */
export interface Actions {
  scope: string
  setDraft: (draft: TreeDraft | null) => void
  /** Open a file; previews yield their tab to the next file, see openTab. */
  open: (path: string, preview?: boolean) => void
  onCreate: (parent: string, name: string, kind: 'file' | 'directory') => void
  onRename: (path: string, name: string) => void
  /** Move or copy entries into toParent. */
  onTransfer: (entries: Picked[], toParent: string, mode: 'move' | 'copy') => void
  /** Propose deletion pending confirmation. */
  onDelete: (entries: Picked[]) => void
  onClipboard: (mode: 'copy' | 'cut', entries: Picked[]) => void
  onPaste: (toParent: string) => void
  onCopyPaths: (paths: string[], absolute: boolean) => void
  /** System files dropped on parent, including directories. */
  onDrop: (parent: string, transfer: DataTransfer) => void
  /** Open the file picker targeting parent. */
  onPickFiles: (parent: string) => void
  /** Displayed rows in screen order, the basis for keyboard and Shift behavior. */
  rows: () => HTMLElement[]
}

/** What changes from one render of the tree to the next, behind the stable `Actions`. */
export type Callbacks = Omit<Actions, 'scope' | 'setDraft' | 'rows'>
