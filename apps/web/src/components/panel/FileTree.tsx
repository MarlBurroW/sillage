import { TooltipButton } from '../ui/Tooltip'
import {
  AtSign,
  ChevronRight,
  ChevronsDownUp,
  CircleAlert,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Download,
  FilePlus2,
  FileSymlink,
  FolderPlus,
  Loader,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Scissors,
  Search,
  SquareCheckBig,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { FileState, TreeEntryDto, TreeListingDto } from '@sillage/protocol'
import { formatBytes } from '../../lib/attachments'
import { copyText } from '../../lib/clipboard'
import { referenceInComposer } from '../../lib/composer-ref'
import { hasDraft, moveDocuments } from '../../lib/editor-documents'
import { closeTab, moveTabs, openTab, useEditorTabs } from '../../lib/editor-tabs'
import {
  parentOf,
  siblingPath,
  useCreateEntry,
  useEntryOperations,
  useMoveEntry,
  type EntryOperation,
  type OperationsOutcome,
} from '../../lib/entries'
import { fileIconUrl } from '../../lib/file-icons'
import { downloadArchive, downloadFile } from '../../lib/files-io'
import { translate, useTranslate } from '../../lib/i18n'
import { useFileSearch, useRefreshTree, useTreeLevel } from '../../lib/tree'
import {
  clearSelection,
  clearTreeClipboard,
  collapseAll,
  forgetInView,
  getTreeView,
  isWithin,
  renameInView,
  revealPath,
  selectMany,
  selectOnly,
  setExpanded,
  setTreeClipboard,
  startSelecting,
  toggleSelected,
  topLevelPaths,
  useTreeView,
  type TreeView,
} from '../../lib/tree-view'
import {
  carriesExternalFiles,
  dismissUpload,
  enqueueUploads,
  filesFromDrop,
  registerTreeRefresh,
  useUploads,
  type Upload as UploadItem,
} from '../../lib/uploads'
import {
  ConfirmDialog,
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  Menu,
  MenuItem,
  MenuSeparator,
  cx,
} from '../ui'

/**
 * Git-status color and letter together: five similar hues are hard to distinguish and inaccessible
 * to users with impaired color perception.
 */
const STATES: Record<FileState, { letter: string; tone: string }> = {
  modified: { letter: 'M', tone: 'text-caution' },
  added: { letter: 'A', tone: 'text-positive' },
  deleted: { letter: 'D', tone: 'text-critical' },
  untracked: { letter: '?', tone: 'text-positive' },
  ignored: { letter: '', tone: 'text-ink-faint/60' },
}

/** Indent per level, tighter than the sidebar because file trees nest deeper. */
const INDENT_PX = 12

/** Drag transfer type carrying JSON entries: the whole selection when dragging a selected row. */
const DRAG_TYPE = 'application/x-sillage-entries'

/** Shortcuts follow the operating system: Command and Option on Mac, Ctrl elsewhere. */
const IS_MAC = navigator.userAgent.includes('Mac')
const MOD = IS_MAC ? '⌘' : 'Ctrl+'
const HINT = { cut: `${MOD}X`, copy: `${MOD}C`, paste: `${MOD}V`, rename: 'F2' }

/** Delete-key label varies by keyboard language, unlike Command-Backspace. */
function deleteHint(): string {
  return IS_MAC ? '⌘⌫' : translate('filetree.key.delete')
}

/** Hold Option on Mac or Ctrl elsewhere to copy instead of move, matching desktop behavior. */
function copyModifier(event: { altKey: boolean; ctrlKey: boolean }): boolean {
  return IS_MAC ? event.altKey : event.ctrlKey
}

/** Active tree input: entry creation or rename. */
type Draft =
  | { mode: 'create'; parent: string; kind: 'file' | 'directory' }
  | { mode: 'rename'; path: string; name: string }

/** Targeted entry path and directory flag. */
type Picked = readonly [path: string, isDirectory: boolean]

function nameOf(path: string): string {
  return path.split('/').pop() ?? path
}

/**
 * Row actions affect the whole selection if the row belongs to it, otherwise just that row. Desktop
 * explorer convention allows acting without losing selections elsewhere.
 */
function targetsOf(view: TreeView, path: string, isDirectory: boolean): Picked[] {
  return view.selection.has(path) ? [...view.selection] : [[path, isDirectory]]
}

/**
 * Header buttons create within the last targeted directory, or the parent of a targeted file, like
 * desktop editors; otherwise root.
 */
function targetFolderOf(view: TreeView): string {
  const anchor = view.anchor
  if (anchor === null || !view.selection.has(anchor)) return ''
  return view.selection.get(anchor) ? anchor : parentOf(anchor)
}

/**
 * Last active file followed by selection, per scope. Outside the component so reopening the column
 * does not undo selection for a file already followed.
 */
const followed = new Map<string, string>()

export function FileTree({
  scope,
  onOpenFile,
}: {
  scope: string
  /** Close the column when overlaying the editor so opened files become visible. */
  onOpenFile: () => void
}) {
  const t = useTranslate()
  const queryClient = useQueryClient()
  const { active: activePath, paths: openPaths } = useEditorTabs(scope)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [query, setQuery] = useState('')
  /** Entries proposed for irreversible deletion. */
  const [pendingDelete, setPendingDelete] = useState<Picked[] | null>(null)
  /** Feedback for actions with no other visible result: copying to clipboard or failures in bulk operations. */
  const [notice, setNotice] = useState<{ tone: 'info' | 'critical'; text: string } | null>(null)
  const create = useCreateEntry(scope)
  const rename = useMoveEntry(scope)
  const operations = useEntryOperations(scope)
  /** Destination for file selection opened from a menu. */
  const [uploadInto, setUploadInto] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const typeahead = useRef({ text: '', at: 0 })
  /** Nested file-drag hover depth for outlining the whole column. */
  const [dragDepth, setDragDepth] = useState(0)
  const target = useTreeView(scope, targetFolderOf)

  const error = create.error ?? rename.error

  // Files arriving in collapsed directories have no watches: this refresh makes them appear on opening.
  const refresh = useRefreshTree(scope)
  useEffect(() => registerTreeRefresh(scope, refresh), [scope, refresh])

  // Selection follows the displayed file like desktop editors: expand and select files opened by
  // tabs or thread links so shortcuts target them.
  useEffect(() => {
    if (!activePath || followed.get(scope) === activePath) return
    followed.set(scope, activePath)
    revealPath(scope, activePath)
    selectOnly(scope, activePath, false)
  }, [scope, activePath])

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

  const actions: Actions = {
    scope,
    activePath,
    draft,
    setDraft,
    open,
    onCreate: (parent, name, kind) => {
      setDraft(null)
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
      setDraft(null)
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
      setDragDepth(0)
      // Dropped directory expansion is asynchronous: queueing waits, not the event handler, which
      // must yield so the browser releases the drag.
      void filesFromDrop(transfer).then((files) => enqueueUploads(scope, parent, files))
    },
    onPickFiles: openPicker,
    rows: () => Array.from(list.current?.querySelectorAll<HTMLElement>('[data-tree-path]') ?? []),
  }

  const startDraft = (kind: 'file' | 'directory') => {
    if (target) setExpanded(scope, target, true)
    setDraft({ mode: 'create', parent: target, kind })
  }

  const searching = query.trim().length >= 2

  return (
    // The entire column accepts files: hitting a 28-pixel row is difficult with mouse and
    // impractical by touch. Drops outside directories target workspace root.
    <div
      className={cx(
        // Full-height column keeps uploads at the bottom rather than after files and accepts drops
        // below the last row too.
        'relative flex min-h-full flex-col',
        dragDepth > 0 && 'outline-2 -outline-offset-2 outline-dashed outline-accent',
      )}
      onDragEnter={(event) => {
        if (!carriesExternalFiles(event.dataTransfer)) return
        event.preventDefault()
        setDragDepth((depth) => depth + 1)
      }}
      onDragLeave={(event) => {
        if (!carriesExternalFiles(event.dataTransfer)) return
        setDragDepth((depth) => Math.max(0, depth - 1))
      }}
      onDragOver={(event) => {
        const external = carriesExternalFiles(event.dataTransfer)
        if (!external && !event.dataTransfer.types.includes(DRAG_TYPE)) return
        // Without preventDefault the browser rejects the drop and opens the file in place of the page.
        event.preventDefault()
        event.dataTransfer.dropEffect = external || copyModifier(event) ? 'copy' : 'move'
      }}
      onDrop={(event) => {
        setDragDepth(0)
        if (carriesExternalFiles(event.dataTransfer)) {
          event.preventDefault()
          actions.onDrop('', event.dataTransfer)
          return
        }
        // Entries dropped outside rows move to root, like a desktop.
        const dragged = readDragged(event)
        if (!dragged) return
        event.preventDefault()
        actions.onTransfer(dragged, '', copyModifier(event) ? 'copy' : 'move')
      }}
    >
      {/* File picker for touch and keyboard: mobile lacks drag-and-drop, which cannot be the only upload route. */}
      <input
        ref={picker}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          enqueueUploads(scope, uploadInto, files.map((file) => ({ file, relativePath: file.name })))
          // Reset so dropping the same file again emits an event.
          event.target.value = ''
        }}
      />

      <div className="flex items-center gap-1 px-2 pb-1">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium text-ink-soft">
          <span className="truncate">{t('filetree.title')}</span>
          {operations.isPending ? <Loader size={11} className="animate-spin text-ink-faint" /> : null}
        </span>
        {/*
         * Creation targets the selected entry's directory or root. Tooltips name this changing
         * destination because buttons stay fixed.
         */}
        <RootAction
          label={target ? t('filetree.header.newFileIn', { folder: target }) : t('filetree.root.newFile')}
          icon={<FilePlus2 size={13} />}
          onClick={() => startDraft('file')}
        />
        <RootAction
          label={
            target ? t('filetree.header.newFolderIn', { folder: target }) : t('filetree.root.newFolder')
          }
          icon={<FolderPlus size={13} />}
          onClick={() => startDraft('directory')}
        />
        <RootAction
          label={target ? t('filetree.header.uploadIn', { folder: target }) : t('filetree.root.upload')}
          icon={<Upload size={13} />}
          onClick={() => {
            if (target) setExpanded(scope, target, true)
            openPicker(target)
          }}
        />
        <RootAction
          label={t('filetree.header.collapse')}
          icon={<ChevronsDownUp size={13} />}
          onClick={() => collapseAll(scope)}
        />
        <RootAction label={t('filetree.header.refresh')} icon={<RefreshCw size={13} />} onClick={refresh} />
      </div>
      <div className="flex items-center gap-1 px-2 pb-1.5">
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-ink-faint"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('')
              // Navigate down search results without returning to the mouse.
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                actions.rows()[0]?.focus()
              }
            }}
            placeholder={t('filetree.search.placeholder')}
            aria-label={t('filetree.search.label')}
            className={cx(
              'h-9 w-full rounded-md border border-line bg-sunken pr-6 pl-7',
              'text-[0.8125rem] text-ink placeholder:text-ink-faint',
              'outline-none focus:border-accent',
            )}
          />
          {query ? (
            <TooltipButton
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('filetree.search.clear')}
              className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-ink-faint hover:text-ink"
            >
              <X size={12} />
            </TooltipButton>
          ) : null}
        </div>
      </div>

      <SelectionBar actions={actions} />

      {error ? (
        <p className="mx-2 mb-1 rounded border border-critical/40 bg-critical/12 px-2 py-1 text-xs text-critical">
          {error instanceof Error ? error.message : t('filetree.error.generic')}
        </p>
      ) : null}

      {notice ? (
        <p
          role={notice.tone === 'critical' ? 'alert' : 'status'}
          className={cx(
            'mx-2 mb-1 flex items-start gap-1.5 rounded border px-2 py-1 text-xs',
            notice.tone === 'critical'
              ? 'border-critical/40 bg-critical/12 text-critical'
              : 'border-line bg-sunken text-ink-soft',
          )}
        >
          <span className="min-w-0 flex-1">{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label={t('uploads.dismiss')}
            className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
          >
            <X size={11} />
          </button>
        </p>
      ) : null}

      {/*
       * Search replaces rather than filters the tree: opening/closing directories around matches
       * would lose context, and clearing must restore expanded levels unchanged.
       */}
      <div
        ref={list}
        className="flex-1 pb-4"
        onKeyDown={(event) => handleTreeKey(event, actions, typeahead.current)}
        // Clicking empty space below rows clears selection, like a desktop.
        onClick={(event) => {
          if (event.target === event.currentTarget) clearSelection(scope)
        }}
      >
        {searching ? (
          <SearchResults scope={scope} query={query} actions={actions} />
        ) : (
          <Level path="" depth={0} expanded actions={actions} />
        )}
      </div>

      <UploadQueue scope={scope} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null)
        }}
        title={
          pendingDelete && pendingDelete.length > 1
            ? t('filetree.delete.confirmMany', { count: pendingDelete.length })
            : pendingDelete?.[0]?.[1]
              ? t('filetree.delete.confirmFolder')
              : t('filetree.delete.confirmFile')
        }
        confirmLabel={t('filetree.delete.confirm')}
        tone="critical"
        onConfirm={() => {
          if (pendingDelete) {
            const paths = topLevelPaths(pendingDelete.map(([path]) => path))
            run(paths.map((path): EntryOperation => ({ kind: 'delete', path })))
          }
          setPendingDelete(null)
        }}
      >
        <ul className="max-h-40 overflow-y-auto font-mono text-xs break-all text-ink">
          {pendingDelete?.map(([path]) => <li key={path}>{path}</li>)}
        </ul>
        <p>
          {pendingDelete && pendingDelete.length > 1
            ? t('filetree.delete.bodyMany')
            : pendingDelete?.[0]?.[1]
              ? t('filetree.delete.bodyFolder')
              : t('filetree.delete.bodyFile')}{' '}
          {t('filetree.delete.note')}
        </p>
      </ConfirmDialog>
    </div>
  )
}

/**
 * Desktop-style explorer shortcuts. Listen on the list rather than individual rows: the event
 * target gives the starting row and DOM order already reflects expanded directories and search
 * results. Reconstructing order from level caches would duplicate rendering work.
 */
function handleTreeKey(
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

/** Displayed row as a path/type pair read from attributes. */
function pickedOf(row: HTMLElement): Picked {
  return [row.dataset.treePath ?? '', row.dataset.treeDir === '1']
}

/**
 * Select from the anchor through to in screen order. Without a visible anchor use the targeted row
 * as the start.
 */
function selectRange(actions: Actions, to: string, additive: boolean): void {
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
function selectFromClick(event: MouseEvent, entry: TreeEntryDto, actions: Actions): boolean {
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

/** Entries dragged from the tree, or null for other drag kinds. */
function readDragged(event: DragEvent): Picked[] | null {
  const raw = event.dataTransfer.getData(DRAG_TYPE)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Picked[]
  } catch {
    return null
  }
}

/**
 * Multi-entry count badge under the drag cursor: the default image shows only the grabbed row and
 * misleadingly suggests it moves alone.
 */
function setDragBadge(event: DragEvent, label: string): void {
  const badge = document.createElement('div')
  badge.textContent = label
  badge.style.cssText =
    'position:fixed;top:-100px;left:0;padding:2px 8px;border-radius:6px;font:12px system-ui;' +
    'background:var(--sg-accent);color:var(--sg-accent-ink)'
  document.body.append(badge)
  event.dataTransfer.setDragImage(badge, -8, -8)
  // The image is captured immediately; remove its element on the next tick.
  setTimeout(() => badge.remove())
}

/**
 * Bulk action bar when multiple entries are selected. Context menus also offer these actions but
 * are undiscoverable, and touch selection mode prevents long-press menus, making this the only
 * touch route.
 */
function SelectionBar({ actions }: { actions: Actions }) {
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

/**
 * Uploads at column bottom rather than top: uploading directories does not shift the tree, and
 * dropped files appear in place without jumping. Success disappears automatically; errors wait to
 * be read.
 */
function UploadQueue({ scope }: { scope: string }) {
  const t = useTranslate()
  const uploads = useUploads(scope)
  if (uploads.length === 0) return null

  return (
    <ul className="sticky bottom-0 z-10 mt-auto border-t border-line bg-surface px-2 py-1.5">
      {uploads.map((upload) => (
        <li key={upload.id} className="flex flex-col gap-0.5 py-0.5">
          <div className="flex items-baseline gap-1.5 text-[0.6875rem]">
            <span
              className={cx(
                'min-w-0 flex-1 truncate',
                upload.status === 'error' ? 'text-critical' : 'text-ink-soft',
              )}
              title={upload.path}
            >
              {upload.label}
            </span>
            <span className="shrink-0 text-ink-faint">{statusOf(upload)}</span>
            <TooltipButton
              type="button"
              onClick={() => dismissUpload(upload.id)}
              aria-label={
                upload.status === 'sending' || upload.status === 'pending'
                  ? t('uploads.cancel')
                  : t('uploads.dismiss')
              }
              className="shrink-0 rounded p-0.5 text-ink-faint hover:text-ink"
            >
              <X size={11} />
            </TooltipButton>
          </div>

          {upload.status === 'error' ? (
            <p className="flex items-start gap-1 text-[0.6875rem] text-critical">
              <CircleAlert size={11} className="mt-0.5 shrink-0" />
              <span className="min-w-0">{upload.error}</span>
            </p>
          ) : (
            // Zero size has no fraction: show a full bar rather than divide by zero; the file is already written anyway.
            <div className="h-1 overflow-hidden rounded-full bg-surface-high">
              <div
                className={cx(
                  'h-full rounded-full transition-[width]',
                  upload.status === 'done' ? 'bg-positive' : 'bg-accent',
                )}
                style={{ width: `${percentOf(upload)}%` }}
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function percentOf(upload: UploadItem): number {
  if (upload.status === 'done' || upload.sizeBytes === 0) return 100
  return Math.min(100, Math.round((upload.sentBytes / upload.sizeBytes) * 100))
}

function statusOf(upload: UploadItem): string {
  if (upload.status === 'error') return translate('uploads.status.error')
  if (upload.status === 'done') return translate('uploads.status.done')
  if (upload.status === 'pending') return translate('uploads.status.pending')
  return translate('uploads.status.sending', {
    sent: formatBytes(upload.sentBytes),
    total: formatBytes(upload.sizeBytes),
  })
}

/** Flat search results: full paths explain file origins better than indentation. */
function SearchResults({
  scope,
  query,
  actions,
}: {
  scope: string
  query: string
  actions: Actions
}) {
  const t = useTranslate()
  const { data, isPending, error } = useFileSearch(scope, query)

  if (error) {
    return (
      <p className="px-2 py-1.5 text-xs text-critical">
        {error instanceof Error ? error.message : t('filetree.search.error')}
      </p>
    )
  }

  if (isPending) {
    return (
      <p className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-ink-faint">
        <Loader size={11} className="animate-spin" />
        {t('filetree.search.loading')}
      </p>
    )
  }

  if (data.entries.length === 0) {
    return <p className="px-2 py-1.5 text-xs text-ink-faint">{t('filetree.search.empty')}</p>
  }

  return (
    <ul role="tree" aria-label={t('filetree.title')} aria-multiselectable>
      {data.entries.map((entry) => (
        <li key={entry.path} role="none">
          <EntryRow entry={entry} actions={actions}>
            <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
              <span className="truncate text-[0.8125rem] text-ink-soft">{entry.name}</span>
              <span className="truncate text-[0.6875rem] text-ink-faint">{entry.path}</span>
            </span>
          </EntryRow>
        </li>
      ))}

      {data.truncated ? (
        <li role="none" className="px-2 py-1.5 text-[0.6875rem] text-ink-faint">
          {t('filetree.search.truncated')}
        </li>
      ) : null}
    </ul>
  )
}

function RootAction({
  label,
  icon,
  onClick,
  compact = false,
}: {
  label: string
  icon: React.ReactNode
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

/**
 * Actions available to rows. Pass one object instead of a dozen props through every recursive
 * level, which does not consume them. Selection stays outside: each row reads its own tree-view
 * state.
 */
interface Actions {
  scope: string
  activePath: string | null
  draft: Draft | null
  setDraft: (draft: Draft | null) => void
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

function Level({
  path,
  depth,
  expanded,
  actions,
}: {
  path: string
  depth: number
  expanded: boolean
  actions: Actions
}) {
  const t = useTranslate()
  const { data, isPending, error } = useTreeLevel(actions.scope, path, expanded)
  const draft = actions.draft
  const creatingHere = draft?.mode === 'create' && draft.parent === path

  if (!expanded) return null

  if (error) {
    return (
      <p className="px-2 py-1 text-xs text-critical" style={{ paddingLeft: depth * INDENT_PX + 8 }}>
        {error instanceof Error ? error.message : t('filetree.error.unreadable')}
      </p>
    )
  }

  if (isPending || !data) {
    return (
      <p
        className="flex items-center gap-1.5 px-2 py-1 text-xs text-ink-faint"
        style={{ paddingLeft: depth * INDENT_PX + 8 }}
      >
        <Loader size={11} className="animate-spin" />
        {t('filetree.loading')}
      </p>
    )
  }

  return (
    <ul
      {...(depth === 0
        ? { role: 'tree', 'aria-label': t('filetree.title'), 'aria-multiselectable': true }
        : { role: 'group' })}
    >
      {creatingHere ? (
        <li role="none">
          <NameInput
            depth={depth}
            icon={fileIconUrl(draft.kind === 'directory' ? 'folder' : 'file', draft.kind === 'directory')}
            initial=""
            onCommit={(name) => actions.onCreate(path, name, draft.kind)}
            onCancel={() => actions.setDraft(null)}
          />
        </li>
      ) : null}

      {data.entries.length === 0 && !creatingHere ? (
        <li
          role="none"
          className="px-2 py-1 text-xs text-ink-faint"
          style={{ paddingLeft: depth * INDENT_PX + 8 }}
        >
          {t('filetree.empty')}
        </li>
      ) : null}

      {data.entries.map((entry) => (
        <Entry key={entry.path} entry={entry} depth={depth} actions={actions} />
      ))}
    </ul>
  )
}

/** Entry action rendered in both menus. */
interface EntryAction {
  key: string
  /** Actions in one group remain consecutive; separators divide groups. */
  group: string
  icon: ReactNode
  label: string
  /** Equivalent keyboard shortcut shown at row end. */
  hint?: string
  tone?: 'critical'
  run: () => void
}

/**
 * Single-entry actions as data rather than elements. Context and ellipsis menus use separate Radix
 * primitives whose entries cannot be shared. Describe once and render twice to prevent divergence.
 */
function entryActions(entry: TreeEntryDto, actions: Actions, view: TreeView): EntryAction[] {
  const { scope } = actions
  const self: Picked[] = [[entry.path, entry.isDirectory]]
  const expand = () => setExpanded(scope, entry.path, true)
  // Select is useful only by touch; mouse Ctrl-click already does this.
  const touch = window.matchMedia('(pointer: coarse)').matches

  return [
    ...(entry.isDirectory
      ? [
          {
            key: 'new-file',
            group: 'create',
            icon: <FilePlus2 size={14} />,
            label: translate('filetree.entry.newFile'),
            run: () => {
              expand()
              actions.setDraft({ mode: 'create', parent: entry.path, kind: 'file' })
            },
          },
          {
            key: 'new-dir',
            group: 'create',
            icon: <FolderPlus size={14} />,
            label: translate('filetree.entry.newFolder'),
            run: () => {
              expand()
              actions.setDraft({ mode: 'create', parent: entry.path, kind: 'directory' })
            },
          },
          {
            key: 'upload',
            group: 'create',
            icon: <Upload size={14} />,
            label: translate('filetree.entry.upload'),
            run: () => {
              expand()
              actions.onPickFiles(entry.path)
            },
          },
        ]
      : [
          {
            key: 'open',
            group: 'open',
            icon: <FileSymlink size={14} />,
            label: translate('filetree.entry.open'),
            run: () => actions.open(entry.path),
          },
          {
            key: 'download',
            group: 'open',
            icon: <Download size={14} />,
            label: translate('filetree.entry.download'),
            run: () => downloadFile(scope, entry.path),
          },
          {
            key: 'reference',
            group: 'open',
            icon: <AtSign size={14} />,
            label: translate('filetree.entry.reference'),
            run: () => referenceInComposer(entry.path),
          },
        ]),
    {
      key: 'cut',
      group: 'clipboard',
      icon: <Scissors size={14} />,
      label: translate('filetree.entry.cut'),
      hint: HINT.cut,
      run: () => actions.onClipboard('cut', self),
    },
    {
      key: 'copy',
      group: 'clipboard',
      icon: <Copy size={14} />,
      label: translate('filetree.entry.copy'),
      hint: HINT.copy,
      run: () => actions.onClipboard('copy', self),
    },
    // Paste inside directories or beside files, matching the click target.
    ...(view.clipboard
      ? [
          {
            key: 'paste',
            group: 'clipboard',
            icon: <ClipboardPaste size={14} />,
            label: translate('filetree.entry.paste'),
            hint: HINT.paste,
            run: () => actions.onPaste(entry.isDirectory ? entry.path : parentOf(entry.path)),
          },
        ]
      : []),
    {
      key: 'duplicate',
      group: 'clipboard',
      icon: <CopyPlus size={14} />,
      label: translate('filetree.entry.duplicate'),
      run: () => actions.onTransfer(self, parentOf(entry.path), 'copy'),
    },
    ...(entry.isDirectory
      ? [
          {
            key: 'download',
            group: 'transfer',
            icon: <Download size={14} />,
            label: translate('filetree.entry.downloadZip'),
            run: () => downloadArchive(scope, [entry.path]),
          },
        ]
      : []),
    {
      key: 'copy-path',
      group: 'path',
      icon: <ClipboardCopy size={14} />,
      label: translate('filetree.entry.copyPath'),
      run: () => actions.onCopyPaths([entry.path], true),
    },
    {
      key: 'copy-relative-path',
      group: 'path',
      icon: <ClipboardCopy size={14} />,
      label: translate('filetree.entry.copyRelativePath'),
      run: () => actions.onCopyPaths([entry.path], false),
    },
    ...(touch
      ? [
          {
            key: 'select',
            group: 'edit',
            icon: <SquareCheckBig size={14} />,
            label: translate('filetree.entry.select'),
            run: () => startSelecting(scope, entry.path, entry.isDirectory),
          },
        ]
      : []),
    {
      key: 'rename',
      group: 'edit',
      icon: <Pencil size={14} />,
      label: translate('filetree.entry.rename'),
      hint: HINT.rename,
      run: () => actions.setDraft({ mode: 'rename', path: entry.path, name: entry.name }),
    },
    {
      key: 'delete',
      group: 'edit',
      icon: <Trash2 size={14} />,
      label: translate('filetree.entry.delete'),
      hint: deleteHint(),
      tone: 'critical' as const,
      run: () => actions.onDelete(self),
    },
  ]
}

/** Bulk-selection actions when the targeted row belongs to it. */
function selectionActions(targets: Picked[], actions: Actions): EntryAction[] {
  const { scope } = actions
  const paths = targets.map(([path]) => path)
  const files = targets.filter(([, isDirectory]) => !isDirectory).map(([path]) => path)

  return [
    {
      key: 'cut',
      group: 'clipboard',
      icon: <Scissors size={14} />,
      label: translate('filetree.entry.cut'),
      hint: HINT.cut,
      run: () => actions.onClipboard('cut', targets),
    },
    {
      key: 'copy',
      group: 'clipboard',
      icon: <Copy size={14} />,
      label: translate('filetree.entry.copy'),
      hint: HINT.copy,
      run: () => actions.onClipboard('copy', targets),
    },
    {
      key: 'download',
      group: 'transfer',
      icon: <Download size={14} />,
      label: translate('filetree.entry.downloadZip'),
      run: () => downloadArchive(scope, paths),
    },
    // Directories have no explorer @ mentions: send only selected files to the composer.
    ...(files.length > 0
      ? [
          {
            key: 'reference',
            group: 'transfer',
            icon: <AtSign size={14} />,
            label: translate('filetree.selection.reference'),
            run: () => files.forEach((path) => referenceInComposer(path)),
          },
        ]
      : []),
    {
      key: 'copy-paths',
      group: 'transfer',
      icon: <ClipboardCopy size={14} />,
      label: translate('filetree.selection.copyPaths'),
      run: () => actions.onCopyPaths(paths, false),
    },
    {
      key: 'clear',
      group: 'edit',
      icon: <X size={14} />,
      label: translate('filetree.selection.clear'),
      run: () => clearSelection(scope),
    },
    {
      key: 'delete',
      group: 'edit',
      icon: <Trash2 size={14} />,
      label: translate('filetree.selection.delete', { count: targets.length }),
      hint: deleteHint(),
      tone: 'critical' as const,
      run: () => actions.onDelete(targets),
    },
  ]
}

/** Contents of both row menus, read when Radix mounts on opening so selection and clipboard are current. */
function EntryMenuItems({
  entry,
  actions,
  variant,
}: {
  entry: TreeEntryDto
  actions: Actions
  variant: 'context' | 'dropdown'
}) {
  const view = getTreeView(actions.scope)
  const targets = targetsOf(view, entry.path, entry.isDirectory)
  const list = targets.length > 1 ? selectionActions(targets, actions) : entryActions(entry, actions, view)
  const Item = variant === 'context' ? ContextMenuItem : MenuItem
  const Separator = variant === 'context' ? ContextMenuSeparator : MenuSeparator

  return (
    <>
      {list.map((action, index) => (
        <Fragment key={action.key}>
          {index > 0 && list[index - 1]?.group !== action.group ? <Separator /> : null}
          <Item icon={action.icon} tone={action.tone} hint={action.hint} onSelect={action.run}>
            {action.label}
          </Item>
        </Fragment>
      ))}
    </>
  )
}

/** Row background precedence: selection, open file, then hover. */
function rowTone(selected: boolean, active: boolean): string {
  if (selected) return 'bg-accent-wash text-ink'
  if (active) return 'bg-accent-wash/45'
  return 'hover:bg-surface-high'
}

/** Search-result row: no chevron, drag-and-drop, or indentation because it represents no tree level. */
function EntryRow({
  entry,
  actions,
  children,
}: {
  entry: TreeEntryDto
  actions: Actions
  children: ReactNode
}) {
  const selected = useTreeView(actions.scope, (view) => view.selection.has(entry.path))
  const active = actions.activePath === entry.path

  return (
    <ContextMenu
      trigger={
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
      }
    >
      <EntryMenuItems entry={entry} actions={actions} variant="context" />
    </ContextMenu>
  )
}

function Entry({
  entry,
  depth,
  actions,
}: {
  entry: TreeEntryDto
  depth: number
  actions: Actions
}) {
  const t = useTranslate()
  const { scope } = actions
  const open = useTreeView(scope, (view) => entry.isDirectory && view.expanded.has(entry.path))
  const selected = useTreeView(scope, (view) => view.selection.has(entry.path))
  const cut = useTreeView(
    scope,
    (view) => view.clipboard?.mode === 'cut' && view.clipboard.entries.has(entry.path),
  )
  const [dropping, setDropping] = useState(false)
  const active = actions.activePath === entry.path
  const button = useRef<HTMLButtonElement>(null)
  const state = entry.state ? STATES[entry.state] : null
  const draft = actions.draft

  // Reveal the editor's current file: tabs or thread links may open files far outside the scrolled viewport.
  useEffect(() => {
    if (active) button.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (draft?.mode === 'rename' && draft.path === entry.path) {
    return (
      <li role="none">
        <NameInput
          depth={depth}
          icon={fileIconUrl(entry.name, entry.isDirectory)}
          initial={entry.name}
          onCommit={(name) => actions.onRename(entry.path, name)}
          onCancel={() => actions.setDraft(null)}
        />
      </li>
    )
  }

  /** Directories accept drops; files forward them to their parent. */
  const dropTarget = entry.isDirectory ? entry.path : parentOf(entry.path)

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    // Stop propagation here or the column would upload files again at root.
    event.stopPropagation()
    setDropping(false)

    // System file drops rather than moved tree entries: directories receive them and files forward
    // them to parents.
    if (carriesExternalFiles(event.dataTransfer)) {
      actions.onDrop(dropTarget, event.dataTransfer)
      return
    }

    // Dropping directories into themselves or descendants is invalid: avoid sending requests the
    // server will reject.
    const dragged = readDragged(event)?.filter(([from]) => !isWithin(dropTarget, from))
    if (dragged?.length) actions.onTransfer(dragged, dropTarget, copyModifier(event) ? 'copy' : 'move')
  }

  return (
    <li role="none">
      <ContextMenu
        trigger={
          <div
            className={cx(
              'group/entry flex items-center transition-colors',
              dropping ? 'bg-accent-wash' : rowTone(selected, active),
              cut && 'opacity-50',
            )}
            draggable
            onDragStart={(event) => {
              // Drag the entire selection when the grabbed row belongs to it.
              const dragged = targetsOf(getTreeView(scope), entry.path, entry.isDirectory)
              event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragged))
              event.dataTransfer.effectAllowed = 'copyMove'
              if (dragged.length > 1) {
                setDragBadge(event, translate('filetree.drag.count', { count: dragged.length }))
              }
            }}
            onDragOver={(event) => {
              const external = carriesExternalFiles(event.dataTransfer)
              // Without preventDefault browsers silently reject drops.
              if (!external && !event.dataTransfer.types.includes(DRAG_TYPE)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = external || copyModifier(event) ? 'copy' : 'move'
              setDropping(true)
            }}
            onDragLeave={() => setDropping(false)}
            onDrop={onDrop}
          >
            <button
              ref={button}
              type="button"
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={selected}
              aria-expanded={entry.isDirectory ? open : undefined}
              aria-current={active ? true : undefined}
              data-tree-path={entry.path}
              data-tree-dir={entry.isDirectory ? '1' : undefined}
              data-tree-name={entry.name}
              onMouseDown={(event) => {
                // Shift-click extends selection; prevent browser text selection too.
                if (event.shiftKey) event.preventDefault()
              }}
              /*
               * Single-click expands directories or opens files, the expected gestures. The tree
               * remains beside the editor, so opening does not abandon browsing. Single-click
               * creates a preview replaced by subsequent files, avoiding tab accumulation;
               * double-click keeps it permanently. Ctrl or Shift clicks only select.
               */
              onClick={(event) => {
                if (selectFromClick(event, entry, actions)) return
                if (entry.isDirectory) setExpanded(scope, entry.path, !open)
                else actions.open(entry.path, true)
              }}
              onDoubleClick={(event) => {
                if (entry.isDirectory || event.shiftKey || event.metaKey || event.ctrlKey) return
                if (getTreeView(scope).selecting) return
                actions.open(entry.path)
              }}
              className={cx(
                'flex h-7 min-w-0 flex-1 items-center gap-1.5 text-left text-[0.8125rem] select-none',
                // Inset the global focus ring or the column would clip it.
                'focus-visible:-outline-offset-2',
                entry.state === 'ignored' ? 'text-ink-faint/60' : 'text-ink-soft',
              )}
              style={{ paddingLeft: depth * INDENT_PX + 6 }}
            >
              {entry.isDirectory ? (
                <ChevronRight
                  size={12}
                  className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')}
                />
              ) : (
                <span className="w-3 shrink-0" />
              )}

              {/* Empty alt because icons repeat adjacent filenames. */}
              <img
                src={fileIconUrl(entry.name, entry.isDirectory, open)}
                alt=""
                aria-hidden
                className="size-4 shrink-0"
              />

              <span className={cx('min-w-0 flex-1 truncate', state && state.tone)}>
                {entry.name}
              </span>

              {state?.letter ? (
                <span className={cx('shrink-0 font-mono text-[0.625rem]', state.tone)}>
                  {state.letter}
                </span>
              ) : null}
            </button>

            {/* Keep menu triggers visible while open or they vanish when pointers leave rows for the menu. */}
            <div
              className={cx(
                'shrink-0 pr-1 opacity-0 transition-opacity',
                'group-hover/entry:opacity-100 has-[[data-state=open]]:opacity-100',
                'focus-within:opacity-100 pointer-coarse:opacity-100',
              )}
            >
              <Menu
                trigger={
                  <TooltipButton
                    type="button"
                    aria-label={t('filetree.entry.actions', { name: entry.name })}
                    className="flex size-11 md:size-7 pointer-coarse:size-11 items-center justify-center rounded text-ink-faint hover:text-ink"
                  >
                    <MoreHorizontal size={14} />
                  </TooltipButton>
                }
              >
                <EntryMenuItems entry={entry} actions={actions} variant="dropdown" />
              </Menu>
            </div>
          </div>
        }
      >
        <EntryMenuItems entry={entry} actions={actions} variant="context" />
      </ContextMenu>

      {entry.isDirectory ? (
        <Level path={entry.path} depth={depth + 1} expanded={open} actions={actions} />
      ) : null}
    </li>
  )
}

/**
 * Name input for creation and rename. Select the basename without extension because renaming
 * usually changes the stem and retyping .tsx adds no value.
 */
function NameInput({
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
