import { ChevronRight, Link2, Loader, MoreHorizontal } from 'lucide-react'
import { memo, useEffect, useRef, useState, type DragEvent } from 'react'
import type { FileState, TreeEntryDto } from '@sillage/protocol'
import { useIsActiveTab } from '../../../lib/editor-tabs'
import { parentOf } from '../../../lib/entries'
import { fileIconUrl } from '../../../lib/file-icons'
import { formatCount, translate, useTranslate } from '../../../lib/i18n'
import { useTreeLevel } from '../../../lib/tree'
import { getTreeView, isWithin, setExpanded, useTreeView } from '../../../lib/tree-view'
import { carriesExternalFiles } from '../../../lib/uploads'
import { cx } from '../../ui'
import { Tooltip } from '../../ui/Tooltip'
import { copyModifier, DRAG_TYPE, readDragged, setDragBadge } from './drag'
import { rowTone } from './EntryRow'
import { NameInput } from './NameInput'
import { openMenuAt, selectFromClick } from './rows-dom'
import { INDENT_PX, targetsOf, type Actions } from './shared'

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

export const Level = memo(function Level({
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
  const creating = useTreeView(actions.scope, (view) =>
    view.draft?.mode === 'create' && view.draft.parent === path ? view.draft.kind : null,
  )
  const creatingHere = creating !== null

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
            icon={fileIconUrl(creating === 'directory' ? 'folder' : 'file', creating === 'directory')}
            initial=""
            onCommit={(name) => actions.onCreate(path, name, creating)}
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

      {/* The server lists a bounded number of entries per level: say so, rather than let the rest look absent. */}
      {data.total > data.entries.length ? (
        <li
          role="none"
          className="px-2 py-1 text-xs text-ink-faint"
          style={{ paddingLeft: depth * INDENT_PX + 8 }}
        >
          {t('filetree.truncated', { shown: formatCount(data.entries.length), total: formatCount(data.total) })}
        </li>
      ) : null}
    </ul>
  )
})

const Entry = memo(function Entry({
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
  const active = useIsActiveTab(scope, entry.path)
  const renaming = useTreeView(scope, (view) => view.draft?.mode === 'rename' && view.draft.path === entry.path)
  /** A link leading outside the working directory, or nowhere: it can be renamed or deleted, not opened. */
  const unreachable = entry.symlink === 'outside'
  const symlinkLabel = entry.symlink ? t(unreachable ? 'filetree.symlink.outside' : 'filetree.symlink.inside') : ''
  const button = useRef<HTMLButtonElement>(null)
  const state = entry.state ? STATES[entry.state] : null

  // Reveal the editor's current file: tabs or thread links may open files far outside the scrolled viewport.
  useEffect(() => {
    if (active) button.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (renaming) {
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
    const dragged = readDragged(event, scope)?.filter(([from]) => !isWithin(dropTarget, from))
    if (dragged?.length) actions.onTransfer(dragged, dropTarget, copyModifier(event) ? 'copy' : 'move')
  }

  return (
    <li role="none">
      <div
        data-tree-entry
        className={cx(
          'group/entry flex items-center transition-colors',
          dropping ? 'bg-accent-wash' : rowTone(selected, active),
          cut && 'opacity-50',
        )}
        draggable
        onDragStart={(event) => {
          // Drag the entire selection when the grabbed row belongs to it.
          const dragged = targetsOf(getTreeView(scope), entry.path, entry.isDirectory)
          event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ scope, entries: dragged }))
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
          data-tree-unreachable={unreachable ? '1' : undefined}
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
            if (selectFromClick(event, entry, actions) || unreachable) return
            if (entry.isDirectory) setExpanded(scope, entry.path, !open)
            else actions.open(entry.path, true)
          }}
          onDoubleClick={(event) => {
            if (entry.isDirectory || unreachable || event.shiftKey || event.metaKey || event.ctrlKey) return
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

          <span className={cx('min-w-0 flex-1 truncate', state && state.tone, unreachable && 'italic text-ink-faint')}>
            {entry.name}
          </span>

          {entry.symlink ? (
            <Tooltip label={symlinkLabel}>
              <span className="shrink-0 text-ink-faint">
                <Link2 size={11} aria-hidden />
                <span className="sr-only">{symlinkLabel}</span>
              </span>
            </Tooltip>
          ) : null}

          {state?.letter ? (
            <span className={cx('shrink-0 font-mono text-[0.625rem]', state.tone)}>
              {state.letter}
            </span>
          ) : null}
        </button>

        <div
          className={cx(
            'shrink-0 pr-1 opacity-0 transition-opacity',
            'group-hover/entry:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100',
          )}
        >
          {/* No tooltip: one per row cost as much to mount as the rows themselves. The label suffices. */}
          <button
            type="button"
            aria-label={t('filetree.entry.actions', { name: entry.name })}
            aria-haspopup="menu"
            onClick={(event) => openMenuAt(event.currentTarget)}
            className="flex size-11 md:size-7 pointer-coarse:size-11 items-center justify-center rounded text-ink-faint hover:text-ink"
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      </div>

      {entry.isDirectory ? (
        <Level path={entry.path} depth={depth + 1} expanded={open} actions={actions} />
      ) : null}
    </li>
  )
})
