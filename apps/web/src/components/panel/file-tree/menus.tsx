import {
  AtSign,
  ChevronsDownUp,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Download,
  FilePlus2,
  FileSymlink,
  FolderPlus,
  Pencil,
  RefreshCw,
  Scissors,
  SquareCheckBig,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import type { TreeEntryDto } from '@sillage/protocol'
import { referenceInComposer } from '../../../lib/composer-ref'
import { parentOf } from '../../../lib/entries'
import { downloadArchive, downloadFile } from '../../../lib/files-io'
import { translate } from '../../../lib/i18n'
import {
  clearSelection,
  collapseAll,
  getTreeView,
  setExpanded,
  startSelecting,
  type TreeView,
} from '../../../lib/tree-view'
import { ContextMenuItem, ContextMenuSeparator } from '../../ui'
import { IS_MAC, targetsOf, type Actions, type Picked } from './shared'

const MOD = IS_MAC ? '⌘' : 'Ctrl+'
const HINT = { cut: `${MOD}X`, copy: `${MOD}C`, paste: `${MOD}V`, rename: 'F2' }

/** Delete-key label varies by keyboard language, unlike Command-Backspace. */
function deleteHint(): string {
  return IS_MAC ? '⌘⌫' : translate('filetree.key.delete')
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
      : entry.symlink === 'outside'
        ? []
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
export function EntryMenuItems({ entry, actions }: { entry: TreeEntryDto; actions: Actions }) {
  const view = getTreeView(actions.scope)
  const targets = targetsOf(view, entry.path, entry.isDirectory)
  const list = targets.length > 1 ? selectionActions(targets, actions) : entryActions(entry, actions, view)
  return <ActionItems list={list} />
}

/** Menu of the empty space below the entries: everything there targets the root. */
export function RootMenuItems({
  actions,
  onCreate,
  onRefresh,
}: {
  actions: Actions
  onCreate: (kind: 'file' | 'directory') => void
  onRefresh: () => void
}) {
  const { scope } = actions
  const list: EntryAction[] = [
    {
      key: 'new-file',
      group: 'create',
      icon: <FilePlus2 size={14} />,
      label: translate('filetree.root.newFile'),
      run: () => onCreate('file'),
    },
    {
      key: 'new-dir',
      group: 'create',
      icon: <FolderPlus size={14} />,
      label: translate('filetree.root.newFolder'),
      run: () => onCreate('directory'),
    },
    {
      key: 'upload',
      group: 'create',
      icon: <Upload size={14} />,
      label: translate('filetree.root.upload'),
      run: () => actions.onPickFiles(''),
    },
    // No shortcut hint: keyboard shortcuts act on a focused row, not on this space.
    ...(getTreeView(scope).clipboard
      ? [
          {
            key: 'paste',
            group: 'clipboard',
            icon: <ClipboardPaste size={14} />,
            label: translate('filetree.entry.paste'),
            run: () => actions.onPaste(''),
          },
        ]
      : []),
    {
      key: 'collapse',
      group: 'view',
      icon: <ChevronsDownUp size={14} />,
      label: translate('filetree.header.collapse'),
      run: () => collapseAll(scope),
    },
    {
      key: 'refresh',
      group: 'view',
      icon: <RefreshCw size={14} />,
      label: translate('filetree.header.refresh'),
      run: onRefresh,
    },
  ]
  return <ActionItems list={list} />
}

/** Action data as menu items, with separators between groups. */
function ActionItems({ list }: { list: EntryAction[] }) {
  const Item = ContextMenuItem
  const Separator = ContextMenuSeparator

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
