import { TooltipButton } from '../ui/Tooltip'
import {
  ChevronsDownUp,
  FilePlus2,
  FolderPlus,
  Loader,
  RefreshCw,
  Search,
  TextSearch,
  Upload,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { TreeEntryDto } from '@sillage/protocol'
import { useEditorTabs } from '../../lib/editor-tabs'
import { useTranslate } from '../../lib/i18n'
import { useRefreshTree } from '../../lib/tree'
import {
  clearSelection,
  collapseAll,
  revealPath,
  selectOnly,
  setExpanded,
  setTreeDraft,
  useTreeView,
} from '../../lib/tree-view'
import { carriesExternalFiles, enqueueUploads, registerTreeRefresh } from '../../lib/uploads'
import { ContextMenu, cx } from '../ui'
import { DeleteDialog } from './file-tree/DeleteDialog'
import { copyModifier, DRAG_TYPE, readDragged } from './file-tree/drag'
import { handleTreeKey } from './file-tree/keyboard'
import { EntryMenuItems, RootMenuItems } from './file-tree/menus'
import { entryAt } from './file-tree/rows-dom'
import { ContentResults, SearchResults } from './file-tree/SearchResults'
import { RootAction, SelectionBar } from './file-tree/SelectionBar'
import { targetFolderOf } from './file-tree/shared'
import { Level } from './file-tree/TreeLevel'
import { UploadQueue } from './file-tree/UploadQueue'
import { useTreeActions } from './file-tree/useTreeActions'

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
  const { active: activePath, paths: openPaths } = useEditorTabs(scope)
  const [query, setQuery] = useState('')
  /** Search file contents rather than names. */
  const [inContent, setInContent] = useState(false)
  /** Row the tree's menu opens for, or null for the empty space (the root). */
  const [menuEntry, setMenuEntry] = useState<TreeEntryDto | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const typeahead = useRef({ text: '', at: 0 })
  /** Nested file-drag hover depth for outlining the whole column. */
  const [dragDepth, setDragDepth] = useState(0)
  const target = useTreeView(scope, targetFolderOf)
  const {
    actions,
    error,
    busy,
    notice,
    setNotice,
    pendingDelete,
    setPendingDelete,
    deleteEntries,
    picker,
    uploadInto,
    openPicker,
  } = useTreeActions({ scope, onOpenFile, openPaths, list, onDropped: () => setDragDepth(0) })

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

  // A name input left open would come back with the column, unfocused.
  useEffect(() => () => setTreeDraft(scope, null), [scope])

  const startDraft = (kind: 'file' | 'directory') => {
    if (target) setExpanded(scope, target, true)
    setTreeDraft(scope, { mode: 'create', parent: target, kind })
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
        const dragged = readDragged(event, scope)
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
          {busy ? <Loader size={11} className="animate-spin text-ink-faint" /> : null}
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
            placeholder={t(inContent ? 'filetree.content.placeholder' : 'filetree.search.placeholder')}
            aria-label={t(inContent ? 'filetree.content.placeholder' : 'filetree.search.label')}
            className={cx(
              'h-9 w-full rounded-md border border-line bg-sunken pr-6 pl-7',
              'text-[0.8125rem] text-ink placeholder:text-ink-faint',
              'outline-none focus:border-accent',
              // The field has its own clear button: the browser's would make two.
              '[&::-webkit-search-cancel-button]:hidden',
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
        <TooltipButton
          type="button"
          aria-label={t('filetree.content.toggle')}
          aria-pressed={inContent}
          onClick={() => setInContent(!inContent)}
          className={cx(
            'flex size-11 shrink-0 items-center justify-center rounded md:size-9 pointer-coarse:size-11',
            inContent ? 'bg-accent-wash text-ink' : 'text-ink-faint hover:bg-surface-high hover:text-ink',
          )}
        >
          <TextSearch size={14} />
        </TooltipButton>
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
      {/*
       * One menu for the whole tree, for the row under the pointer. A menu per row (plus the …
       * dropdown and its tooltip) took about half a second to mount for a thousand rows. The row
       * is read from the event before the menu opens: right-click, long press, the context-menu
       * key, or a row's … button, which opens it in place.
       */}
      <ContextMenu
        trigger={
          <div
            ref={list}
            className="flex flex-1 flex-col"
            onKeyDown={(event) => handleTreeKey(event, actions, typeahead.current)}
            onContextMenu={(event) => setMenuEntry(entryAt(event.target))}
            // A long press opens the menu later, from this event: note its row now.
            onPointerDown={(event) => {
              if (event.pointerType !== 'mouse') setMenuEntry(entryAt(event.target))
            }}
          >
            {searching && inContent ? (
              <ContentResults scope={scope} query={query} actions={actions} />
            ) : searching ? (
              <SearchResults scope={scope} query={query} actions={actions} />
            ) : (
              <Level path="" depth={0} expanded actions={actions} />
            )}
            {/*
             * Empty space below the entries: its menu aims at the root, like a desktop explorer.
             * Creating there used to require clearing the selection so header buttons would target
             * it. Clicking it clears selection.
             */}
            <div data-tree-background className="min-h-10 flex-1" onClick={() => clearSelection(scope)} />
          </div>
        }
      >
        {menuEntry ? (
          <EntryMenuItems entry={menuEntry} actions={actions} />
        ) : (
          <RootMenuItems
            actions={actions}
            onCreate={(kind) => {
              // Search results replace the tree, where the name input appears.
              setQuery('')
              setTreeDraft(scope, { mode: 'create', parent: '', kind })
            }}
            onRefresh={refresh}
          />
        )}
      </ContextMenu>

      <UploadQueue scope={scope} />

      <DeleteDialog
        pending={pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={deleteEntries}
      />
    </div>
  )
}
