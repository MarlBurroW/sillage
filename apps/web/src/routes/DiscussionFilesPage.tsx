import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, FolderOpen, PanelLeft, Trash2 } from 'lucide-react'
import { setPanelTree, usePanelTree } from '../lib/panel'
import { useTranslate } from '../lib/i18n'
import { useDeletePersonalWorkspace, usePersonalWorkspaces } from '../lib/discussions'
import { personalWorkspaceScope } from '../lib/workspace-scope'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { FilesPane } from '../components/panel/FilesPane'
import { Banner, Button, ConfirmDialog, IconButton } from '../components/ui'

export function DiscussionFilesPage() {
  const t = useTranslate()
  const { data, error } = usePersonalWorkspaces()
  const remove = useDeletePersonalWorkspace()
  const treeOpen = usePanelTree()
  const [selected, setSelected] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const workspace = data?.find(entry => entry.id === selected)
  return <div className="flex h-full min-h-0 min-w-0 flex-col">
    <header className="flex shrink-0 items-center gap-3 border-b border-line p-3">
      <MobileNavigationButton />
      {workspace ? <IconButton label={t('discussions.files.back')} onClick={() => setSelected(null)}><ArrowLeft size={18} /></IconButton> : null}
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{workspace?.name ?? t('discussions.files')}</h1>
      {workspace ? <IconButton label={t(treeOpen ? 'panel.tree.hide' : 'panel.tree.show')} onClick={() => setPanelTree(!treeOpen)}><PanelLeft size={18} /></IconButton> : null}
    </header>
    {error || remove.error ? <Banner>{(error ?? remove.error)?.message}</Banner> : null}
    {workspace ? <FilesPane key={workspace.id} scope={personalWorkspaceScope(workspace.id)} /> : <div className="mx-auto w-full max-w-3xl overflow-y-auto p-4 md:p-8">
      <p className="mb-6 text-sm text-ink-soft">{t('discussions.files.description')}</p>
      {data?.length === 0 ? <p className="text-sm text-ink-faint">{t('discussions.files.empty')}</p> : null}
      <ul className="divide-y divide-line">{data?.map(entry => <li key={entry.id} className="flex items-start gap-3 py-4">
        <FolderOpen size={18} className="mt-2 shrink-0 text-ink-faint" />
        <div className="min-w-0 flex-1">
          <Button variant="ghost" className="max-w-full justify-start" onClick={() => { setSelected(entry.id); setPanelTree(true, false) }}><span className="truncate">{entry.name}</span></Button>
          <p className="break-all font-mono text-xs text-ink-faint">{entry.path}</p>
          {entry.conversations.length ? <div className="mt-2 flex flex-wrap gap-3">{entry.conversations.map(session => <Link className="text-xs text-accent hover:underline" key={session.id} to={`/discussions/${session.id}`}>{session.title}</Link>)}</div> : <p className="mt-2 text-xs text-ink-soft">{t('discussions.files.retained')}</p>}
        </div>
        {!entry.conversations.length ? <IconButton label={t('discussions.files.delete')} onClick={() => setDeleting(entry.id)}><Trash2 size={16} /></IconButton> : null}
      </li>)}</ul>
    </div>}
    <ConfirmDialog open={Boolean(deleting)} onOpenChange={open => { if (!open) setDeleting(null) }} title={t('discussions.files.delete')} confirmLabel={t('shell.delete')} tone="critical" busy={remove.isPending}
      onConfirm={() => { if (deleting) remove.mutate(deleting, { onSuccess: () => setDeleting(null) }) }}>
      <p>{t('discussions.files.deleteConfirm')}</p>
      <p className="mt-2 break-all font-mono text-xs">{data?.find(entry => entry.id === deleting)?.path}</p>
    </ConfirmDialog>
  </div>
}
