import * as Dialog from '@radix-ui/react-dialog'
import { Folder, FolderPlus, Folders, Unlink2, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslate } from '../lib/i18n'
import { useAttachProjectFolder, useDetachProjectFolder, useProjectFolders } from '../lib/project-folders'
import { DirectoryPicker } from './DirectoryPicker'
import { Banner, Button, IconButton } from './ui'

export function NewProjectFolders({ paths, onChange, initialPath }: {
  paths: string[]
  onChange: (paths: string[]) => void
  initialPath: string
}) {
  return <FolderLinks paths={paths} initialPath={initialPath}
    onAdd={path => { if (!paths.includes(path)) onChange([...paths, path]) }}
    onRemove={path => onChange(paths.filter(entry => entry !== path))} />
}

export function ProjectFolderSettings({ projectId, workspacePath, isOwner }: {
  projectId: string
  workspacePath: string
  isOwner: boolean
}) {
  const folders = useProjectFolders(projectId)
  const attach = useAttachProjectFolder(projectId)
  const detach = useDetachProjectFolder(projectId)
  return <FolderLinks paths={folders.data?.map(folder => folder.path) ?? []} initialPath={workspacePath}
    loading={folders.isPending} busy={attach.isPending || detach.isPending}
    error={folders.error ?? attach.error ?? detach.error}
    onAdd={isOwner ? path => { detach.reset(); attach.mutate(path) } : undefined}
    onRemove={isOwner ? path => {
      const folder = folders.data?.find(entry => entry.path === path)
      if (folder) { attach.reset(); detach.mutate(folder.id) }
    } : undefined} />
}

function FolderLinks({ paths, initialPath, onAdd, onRemove, error, loading, busy }: {
  paths: string[]
  initialPath: string
  onAdd?: (path: string) => void
  onRemove?: (path: string) => void
  error?: Error | null
  loading?: boolean
  busy?: boolean
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild>
      <Button type="button" variant="secondary" size="sm" className="self-start" icon={<Folders size={15} />}>
        {t('project.folders.title')}{paths.length ? <span className="text-ink-faint">({paths.length})</span> : null}
      </Button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
      <Dialog.Content className="surface fixed inset-x-3 top-1/2 z-50 mx-auto flex max-h-[85dvh] max-w-lg -translate-y-1/2 flex-col rounded-lg border border-line shadow-pop">
        <header className="flex shrink-0 items-center gap-2 px-4 pt-3">
          <Dialog.Title className="min-w-0 flex-1 font-semibold">{t('project.folders.title')}</Dialog.Title>
          <Dialog.Close asChild><IconButton type="button" label={t('common.close')}><X size={16} /></IconButton></Dialog.Close>
        </header>
        <Dialog.Description className="px-4 pb-3 text-sm text-ink-soft">{t('project.folders.description')}</Dialog.Description>
        <div className="min-h-0 overflow-y-auto border-t border-line px-4">
          {error ? <div className="py-3"><Banner>{error.message}</Banner></div> : null}
          {paths.length ? <ul className="divide-y divide-line">
            {paths.map(path => <li key={path} className="flex min-h-11 items-center gap-2 py-1">
              <Folder size={15} className="shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 break-all font-mono text-xs text-ink">{path}</span>
              {onRemove ? <IconButton type="button" size="sm" disabled={busy} label={t('project.folders.unlink', { path })} onClick={() => onRemove(path)}>
                <Unlink2 size={15} />
              </IconButton> : null}
            </li>)}
          </ul> : !error ? <p className="py-4 text-sm text-ink-faint">{t(loading ? 'filetree.loading' : 'project.folders.empty')}</p> : null}
        </div>
        {onAdd ? <footer className="shrink-0 border-t border-line px-4 py-3">
          <Button type="button" size="sm" icon={<FolderPlus size={15} />} disabled={busy || loading} onClick={() => setPicking(true)}>
            {t('project.folders.add')}
          </Button>
        </footer> : null}
        {picking && onAdd ? <DirectoryPicker open initialPath={paths.at(-1) ?? initialPath} onOpenChange={setPicking} onConfirm={onAdd} /> : null}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
