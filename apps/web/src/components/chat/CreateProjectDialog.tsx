import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { conversationPath, type ConversationDto } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { useContinueInProject } from '../../lib/discussions'
import { useFileSearch, useTreeLevel } from '../../lib/tree'
import { NewFolderForm } from '../../routes/NewProjectPage'
import { Field, IconButton } from '../ui'

/** The explicit brief is the only conversation content crossing into the project. */
export function CreateProjectDialog({ source, onOpenChange }: { source: ConversationDto; onOpenChange: (open: boolean) => void }) {
  const t = useTranslate()
  const navigate = useNavigate()
  const create = useContinueInProject(source.id)
  const [brief, setBrief] = useState('')
  const [start, setStart] = useState(false)
  const [prompt, setPrompt] = useState(() => t('conversation.continuation.prompt'))
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const { data: root } = useTreeLevel(source.id, '', true)
  const { data: search } = useFileSearch(source.id, query)
  const entries = query.trim().length >= 2 ? search?.entries : root?.entries
  const files = [...new Set([...selected, ...(entries ?? []).filter(entry => !entry.isDirectory).map(entry => entry.path)])]
  return <Dialog.Root open onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
    <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90dvh] w-[min(36rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-lg border border-line surface p-4 shadow-pop">
      <div className="flex items-center justify-between gap-3"><Dialog.Title className="text-sm font-semibold">{t('discussions.project.create')}</Dialog.Title><Dialog.Close asChild><IconButton label={t('common.close')}><X size={18} /></IconButton></Dialog.Close></div>
      <Dialog.Description className="text-sm text-ink-soft">{t('discussions.project.description')}</Dialog.Description>
      <NewFolderForm pending={create.isPending} error={create.error?.message} onCreate={project => create.mutate({ project, brief, files: selected, ...(start ? { prompt } : {}) }, { onSuccess: session => { onOpenChange(false); navigate(conversationPath(session)) } })}>
        <label className="flex flex-col gap-2 text-sm">{t('discussions.project.brief')}<textarea className="min-h-32 rounded-md border border-line bg-canvas p-3" value={brief} onChange={event => setBrief(event.target.value)} required maxLength={40000} placeholder={t('discussions.project.briefHint')} /></label>
        <Field type="search" label={t('discussions.project.files')} hint={t('discussions.project.filesHint')} value={query} onChange={event => setQuery(event.target.value)} />
        <div className="max-h-48 overflow-y-auto">{files.map(file => <label key={file} className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(file)} onChange={event => setSelected(current => event.target.checked ? [...current, file] : current.filter(entry => entry !== file))} /><span className="break-all font-mono text-xs">{file}</span></label>)}</div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={start} onChange={event => setStart(event.target.checked)} />{t('discussions.project.start')}</label>
        {start ? <label className="flex flex-col gap-2 text-sm">{t('discussions.project.prompt')}<textarea className="min-h-20 rounded-md border border-line bg-canvas p-3" value={prompt} onChange={event => setPrompt(event.target.value)} required maxLength={40000} /></label> : null}
      </NewFolderForm>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
