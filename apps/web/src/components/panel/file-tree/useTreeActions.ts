import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { TreeListingDto } from '@sillage/protocol'
import { copyText } from '../../../lib/clipboard'
import { hasDraft, moveDocuments } from '../../../lib/editor-documents'
import { closeTab, moveTabs, openTab } from '../../../lib/editor-tabs'
import {
  parentOf,
  siblingPath,
  useCreateEntry,
  useEntryOperations,
  useMoveEntry,
  type EntryOperation,
  type OperationsOutcome,
} from '../../../lib/entries'
import { useTranslate } from '../../../lib/i18n'
import {
  clearTreeClipboard,
  forgetInView,
  getTreeView,
  isWithin,
  renameInView,
  revealPath,
  selectMany,
  selectOnly,
  setTreeClipboard,
  setTreeDraft,
  topLevelPaths,
} from '../../../lib/tree-view'
import { enqueueUploads, filesFromDrop } from '../../../lib/uploads'
import { nameOf, type Actions, type Callbacks, type Picked } from './shared'

/** Feedback for actions with no other visible result: copying to clipboard or failures in bulk operations. */
export type TreeNotice = { tone: 'info' | 'critical'; text: string }

/**
 * Everything the tree does to the workspace: create, rename, move, copy, delete, clipboard, uploads.
 * Effects are applied to the tree view and the editor tabs once the server has answered.
 */
export function useTreeActions({
  scope,
  onOpenFile,
  openPaths,
  list,
  onDropped,
}: {
  scope: string
  onOpenFile: () => void
  /** Paths of the open editor tabs, closed when their file is deleted. */
  openPaths: readonly string[]
  /** The rows' container, read for their screen order. */
  list: RefObject<HTMLDivElement | null>
  /** System files were dropped somewhere in the tree. */
  onDropped: () => void
}) {
  const t = useTranslate()
  const queryClient = useQueryClient()
  /** Entries proposed for irreversible deletion. */
  const [pendingDelete, setPendingDelete] = useState<Picked[] | null>(null)
  const [notice, setNotice] = useState<TreeNotice | null>(null)
  const create = useCreateEntry(scope)
  const rename = useMoveEntry(scope)
  const operations = useEntryOperations(scope)
  /** Destination for file selection opened from a menu. */
  const [uploadInto, setUploadInto] = useState('')
  const picker = useRef<HTMLInputElement>(null)

  const error = create.error ?? rename.error

  useEffect(() => {
    if (notice?.tone !== 'info') return
    const timer = setTimeout(() => setNotice(null), 2500)
    return () => clearTimeout(timer)
  }, [notice])

  const openPicker = (parent: string) => {
    setUploadInto(parent)
    picker.current?.click()
  }

  const open = (path: string, preview = false) => {
    openTab(scope, path, { preview })
    onOpenFile()
  }

  /** After successful rename or move, update view and tabs to follow the entry. */
  const moved = (from: string, to: string) => {
    renameInView(scope, from, to)
    moveDocuments(scope, from, to)
    moveTabs(scope, from, to)
  }

  /**
   * Successful deletion closes affected tabs except unsaved drafts, which remain the last
   * recoverable copy of work.
   */
  const removed = (paths: string[]) => {
    forgetInView(scope, paths)
    for (const path of openPaths) {
      if (paths.some((gone) => isWithin(path, gone)) && !hasDraft(scope, path)) closeTab(scope, path)
    }
  }

  /** Run operations sequentially and apply their effects to the view. */
  const run = (list: EntryOperation[], after?: (done: OperationsOutcome['done']) => void) => {
    if (list.length === 0) return
    setNotice(null)
    operations.mutate(list, {
      onSuccess: ({ done, failures }) => {
        for (const { operation } of done) {
          if (operation.kind === 'move') moved(operation.from, operation.to)
        }
        const deleted = done.flatMap(({ operation }) =>
          operation.kind === 'delete' ? [operation.path] : [],
        )
        if (deleted.length > 0) removed(deleted)
        after?.(done)

        const [first, ...others] = failures
        if (first) {
          setNotice({
            tone: 'critical',
            text:
              others.length === 0
                ? first.message
                : t(others.length > 1 ? 'filetree.failures.more.other' : 'filetree.failures.more.one', {
                    message: first.message,
                    count: others.length,
                  }),
          })
        }
      },
    })
  }

  const transfer = (entries: Picked[], toParent: string, mode: 'move' | 'copy') => {
    const kinds = new Map(entries)
    const sources = topLevelPaths(kinds.keys())
      // Moving to the current location would only yield an already-exists error. Copying there
      // still makes sense as duplication.
      .filter((from) => mode === 'copy' || parentOf(from) !== toParent)

    run(
      sources.map((from): EntryOperation =>
        mode === 'copy'
          ? { kind: 'copy', from, toParent }
          : { kind: 'move', from, to: toParent ? `${toParent}/${nameOf(from)}` : nameOf(from) },
      ),
      (done) => {
        // Select and reveal new entries where attention and the next action belong, such as renaming a copy.
        const arrived = done.map(({ operation, path }): Picked => {
          const from = operation.kind === 'delete' ? operation.path : operation.from
          return [path, kinds.get(from) ?? false]
        })
        const first = arrived[0]?.[0]
        if (first) revealPath(scope, first)
        selectMany(scope, arrived, { anchor: first })
      },
    )
  }

  /** Delete the confirmed entries, a directory's descendants going with it. */
  const deleteEntries = (entries: Picked[]) => {
    const paths = topLevelPaths(entries.map(([path]) => path))
    run(paths.map((path): EntryOperation => ({ kind: 'delete', path })))
  }

  const latest = useRef<Callbacks | null>(null)
  latest.current = {
    open,
    onCreate: (parent, name, kind) => {
      setTreeDraft(scope, null)
      create.mutate(
        { parent, name, kind },
        {
          // Select new entries and open files because creation usually precedes immediate editing.
          onSuccess: ({ path }) => {
            selectOnly(scope, path, kind === 'directory')
            if (kind === 'file') open(path)
          },
        },
      )
    },
    onRename: (path, name) => {
      setTreeDraft(scope, null)
      const to = siblingPath(path, name)
      if (name !== nameOf(path)) {
        rename.mutate({ from: path, to }, { onSuccess: () => moved(path, to) })
      }
    },
    onTransfer: transfer,
    onDelete: setPendingDelete,
    onClipboard: (mode, entries) => {
      setTreeClipboard(scope, mode, entries)
      const plural = entries.length > 1 ? 'other' : 'one'
      setNotice({
        tone: 'info',
        text: t(`filetree.clipboard.${mode === 'cut' ? 'cut' : 'copied'}.${plural}`, {
          count: entries.length,
        }),
      })
    },
    onPaste: (toParent) => {
      const clipboard = getTreeView(scope).clipboard
      if (!clipboard) return
      transfer([...clipboard.entries], toParent, clipboard.mode === 'cut' ? 'move' : 'copy')
      // After cutting, the original has moved: a second paste would fail.
      if (clipboard.mode === 'cut') clearTreeClipboard(scope)
    },
    onCopyPaths: (paths, absolute) => {
      // Root comes from the first level, always loaded when the tree displays.
      const root = queryClient.getQueryData<TreeListingDto>(['tree', scope, ''])?.root
      const text = paths.map((path) => (absolute && root ? `${root}/${path}` : path)).join('\n')
      void copyText(text).then((ok) =>
        setNotice(
          ok
            ? {
                tone: 'info',
                text: t(paths.length > 1 ? 'filetree.paths.copied.other' : 'filetree.paths.copied.one', {
                  count: paths.length,
                }),
              }
            : { tone: 'critical', text: t('filetree.paths.failed') },
        ),
      )
    },
    onDrop: (parent, transfer) => {
      // Remove drop feedback here too: receiving rows stop propagation before root and no dragleave follows drop.
      onDropped()
      // Dropped directory expansion is asynchronous: queueing waits, not the event handler, which
      // must yield so the browser releases the drag.
      void filesFromDrop(transfer).then((files) => enqueueUploads(scope, parent, files))
    },
    onPickFiles: openPicker,
  }

  /**
   * Rows are memoized and all receive `actions`: its identity must survive renders of the tree
   * (an opened tab, a notice, a drag over the column), or each click redrew every row, about half
   * a second with a thousand of them. Methods forward to the latest render's callbacks.
   */
  const actions = useMemo<Actions>(() => {
    const current = () => latest.current as Callbacks
    return {
      scope,
      setDraft: (draft) => setTreeDraft(scope, draft),
      open: (path, preview) => current().open(path, preview),
      onCreate: (parent, name, kind) => current().onCreate(parent, name, kind),
      onRename: (path, name) => current().onRename(path, name),
      onTransfer: (entries, toParent, mode) => current().onTransfer(entries, toParent, mode),
      onDelete: (entries) => current().onDelete(entries),
      onClipboard: (mode, entries) => current().onClipboard(mode, entries),
      onPaste: (toParent) => current().onPaste(toParent),
      onCopyPaths: (paths, absolute) => current().onCopyPaths(paths, absolute),
      onDrop: (parent, transfer) => current().onDrop(parent, transfer),
      onPickFiles: (parent) => current().onPickFiles(parent),
      rows: () => Array.from(list.current?.querySelectorAll<HTMLElement>('[data-tree-path]') ?? []),
    }
  }, [scope, list])

  return {
    actions,
    /** A create or rename failed. */
    error,
    /** Bulk operations are running. */
    busy: operations.isPending,
    notice,
    setNotice,
    pendingDelete,
    setPendingDelete,
    deleteEntries,
    picker,
    uploadInto,
    openPicker,
  }
}
