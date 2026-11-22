import type { ExplorerFolderDto, ProjectFolderDto } from '@sillage/protocol'
import { Check, ChevronDown, Folder, FolderOpen, LoaderCircle } from 'lucide-react'
import { Fragment, useState } from 'react'
import { useExplorerFolderHistory, useOpenExplorerFolder, useSelectExplorerFolder } from '../../lib/explorer-folders'
import { useTranslate } from '../../lib/i18n'
import { setPanelTree } from '../../lib/panel'
import { useProjectFolders } from '../../lib/project-folders'
import { useTreeLevel } from '../../lib/tree'
import { decodeScope, type WorkspaceScope } from '../../lib/workspace-scope'
import { DirectoryPicker } from '../DirectoryPicker'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../ui'

function folderName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export function FolderSwitcher({ scope, projectId, selected, rootPath: fallbackPath }: {
  scope: WorkspaceScope
  projectId: string | null
  selected: ExplorerFolderDto | ProjectFolderDto | null
  rootPath: string
}) {
  const t = useTranslate()
  const { recent } = useExplorerFolderHistory(scope)
  const select = useSelectExplorerFolder(scope)
  const openFolder = useOpenExplorerFolder()
  const [picking, setPicking] = useState(false)
  const folders = useProjectFolders(projectId)
  const attached = folders.data ?? []
  const tree = useTreeLevel(scope, '', !fallbackPath && !selected)
  const rootPath = tree.data?.root ?? fallbackPath
  const currentPath = selected?.path ?? rootPath
  const rootLabel = t(decodeScope(scope).kind === 'project' ? 'panel.folder.project' : 'panel.folder.session')
  const name = folderName(currentPath) || rootLabel

  function showFolder(folder: ExplorerFolderDto | ProjectFolderDto | null) {
    openFolder.reset()
    select(folder)
    setPanelTree(true, false)
  }

  return <>
    <Menu align="start" scrollable onOpenChange={open => { if (open && projectId) void folders.refetch() }} trigger={
      <button type="button" disabled={openFolder.isPending} title={currentPath || rootLabel}
        aria-label={t('panel.folder.switch', { name })}
        className="flex min-h-6 max-w-full items-center gap-1 rounded text-xs text-ink-soft hover:text-ink focus-visible:outline-accent">
        {openFolder.isPending ? <LoaderCircle size={12} className="shrink-0 animate-spin" /> : <Folder size={12} className="shrink-0" />}
        <span className="truncate">{name}</span><ChevronDown size={12} className="shrink-0" />
      </button>
    }>
      <MenuItem icon={<FolderOpen size={15} />} onSelect={() => setPicking(true)}>{t('panel.folder.open')}</MenuItem>
      <MenuSeparator />
      <MenuItem icon={selected ? <Folder size={15} /> : <Check size={15} />} onSelect={() => showFolder(null)}>
        <FolderLabel name={rootLabel} path={rootPath} />
      </MenuItem>
      {[
        { label: t('panel.folder.attached'), folders: attached },
        { label: t('panel.folder.recent'), folders: recent },
      ].filter(group => group.folders.length).map(group => <Fragment key={group.label}>
        <MenuLabel>{group.label}</MenuLabel>
        {group.folders.map(folder => <MenuItem key={folder.id}
          icon={folder.id === selected?.id ? <Check size={15} /> : <Folder size={15} />}
          onSelect={() => showFolder(folder)}>
          <FolderLabel name={folderName(folder.path)} path={folder.path} />
        </MenuItem>)}
      </Fragment>)}
      {folders.error ? <p role="alert" className="px-2 text-xs text-critical">{folders.error.message}</p> : null}
    </Menu>
    {openFolder.error ? <p role="alert" className="text-xs text-critical">{openFolder.error.message}</p> : null}
    {picking ? <DirectoryPicker open initialPath={currentPath} onOpenChange={setPicking} onConfirm={path => {
      const linked = attached.find(folder => folder.path === path)
      if (path === rootPath) showFolder(null)
      else if (linked) showFolder(linked)
      else openFolder.mutate(path, { onSuccess: folder => showFolder(folder.path === rootPath ? null : folder) })
    }} /> : null}
  </>
}

function FolderLabel({ name, path }: { name: string; path: string }) {
  return <span className="min-w-0 max-w-[min(75vw,25rem)]" title={path}>
    <span className="block truncate">{name}</span>
    {path ? <span className="block truncate font-mono text-xs text-ink-faint">{path}</span> : null}
  </span>
}
